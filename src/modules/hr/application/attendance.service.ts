/**
 * AttendanceService — three-mode capture (bulk-capable) + the ONE posting in this half: the daily-labour
 * accrual at head-count confirmation (design §5.1, FR-HR-004..012). Capture of OFFICE / SUBCONTRACTOR /
 * DAILY_LABOUR rows persists tracking data and posts NOTHING (subcontractor is GL-free — FR-HR-005).
 * OFFICE capture writes through the shared PUNCH PIPELINE (`insertPunches` → `reconcileDays`), so all
 * four ingestion paths — device push, device pull, spreadsheet import, manual entry — converge on one
 * writer of `check_in`/`check_out` and one row per employee-day (`captureOffice`, design §4.1).
 * `confirmDailyLabour` is the only ledger-touching path: inside ONE uow.run it row-locks the row, guards
 * DAILY_LABOUR + unconfirmed, resolves the labour accounts (MAS), builds the balanced DAILY_LABOUR_ACCRUAL
 * command and calls the REAL PostingService.post (period→project→tags→refs→balance→NUMBER-last→write),
 * records the accrual_entry_id + writes the LabourPayable, and marks CONFIRMED — all atomic (FR-LED-016).
 * `reverseAccrual` corrects a confirmed accrual by PostingService.reverse (append-only; FR-HR-012).
 * `applySettlement` consumes a PAY settlement to roll up the payable WITHOUT re-posting (FR-HR-011).
 * HR builds NO journal row itself and opens no transaction of its own (CLAUDE.md non-negotiable 2).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Money } from '../../../common/money';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import {
  ATTENDANCE_SOURCE_TYPE,
  AttendanceMode,
  AttendanceRecord,
  EditDailyLabour,
  NewAttendance,
} from '../domain/attendance-record';
import { accrualLineFor, buildAccrualCommand } from '../domain/accrual-command.factory';
import { LabourPayable } from '../domain/labour-payable';
import {
  AttendanceConfirmedImmutableError,
  AttendanceNotConfirmedError,
} from '../domain/errors';
import { ATTENDANCE_REPOSITORY, AttendanceRepository } from '../domain/ports/attendance.repository';
import {
  LABOUR_PAYABLE_REPOSITORY,
  LabourPayableRepository,
} from '../domain/ports/labour-payable.repository';
import {
  PUNCH_INGESTION_REPOSITORY,
  PunchIngestionRepository,
  PunchToStore,
} from '../attendance-reports/domain/ports/punch-ingestion.repository';
import { normaliseTime } from '../attendance-reports/domain/attendance-import.parser';
import { parseDeviceTimestamp } from '../attendance-reports/domain/punch-payload.parser';
import {
  HR_ACCOUNT_RESOLVER_PORT,
  HrAccountResolverPort,
} from '../domain/ports/hr-account-resolver.port';
import { HR_PROJECT_STATUS_PORT, HrProjectStatusPort } from '../domain/ports/project-status.port';
import { POSTING_SERVICE_PORT, PostingServicePort } from '../domain/ports/posting.service.port';

export interface ConfirmResult {
  attendanceId: string;
  accrualEntryId: string;
  entryNo: string;
  accruedAmount: string;
  isConfirmed: true;
}

export interface ReverseResult {
  reversalEntryId: string;
  reversalEntryNo: string;
  originalEntryId: string;
}

/** A required field the DTO already validates — asserted again so the domain is never fed a blank. */
function requireField(value: string | null | undefined, field: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new ValidationError(`${field} is required`);
  return trimmed;
}

@Injectable()
export class AttendanceService {
  constructor(
    @Inject(ATTENDANCE_REPOSITORY) private readonly repo: AttendanceRepository,
    @Inject(LABOUR_PAYABLE_REPOSITORY) private readonly payables: LabourPayableRepository,
    @Inject(HR_ACCOUNT_RESOLVER_PORT) private readonly accounts: HrAccountResolverPort,
    @Inject(HR_PROJECT_STATUS_PORT) private readonly projectStatus: HrProjectStatusPort,
    @Inject(POSTING_SERVICE_PORT) private readonly posting: PostingServicePort,
    @Inject(PUNCH_INGESTION_REPOSITORY) private readonly punches: PunchIngestionRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /** Capture one or more attendance rows of a given mode (bulk, FR-HR-007). No ledger impact. */
  async capture(mode: AttendanceMode, rows: NewAttendance[], actor: Actor): Promise<{ ids: string[] }> {
    // OFFICE writes through the punch pipeline instead of inserting an aggregate directly, so that
    // `reconcileDays` stays the ONLY writer of check_in/check_out (design §4.1). SUBCONTRACTOR and
    // DAILY_LABOUR are head counts, not punches — nothing to reconcile, so they are untouched.
    if (mode === 'OFFICE') return this.captureOffice(rows, actor);

    return this.uow.run(async () => {
      const records: AttendanceRecord[] = [];
      for (const row of rows) {
        records.push(
          AttendanceRecord.capture(this.ids.next(), actor.companyId, actor.financialYearId, {
            ...row,
            mode,
          }),
        );
      }
      await this.repo.insertMany(records);
      await this.audit.record({
        action: 'CREATE',
        entityType: ATTENDANCE_SOURCE_TYPE,
        entityId: records.map((r) => r.id).join(','),
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { ids: records.map((r) => r.id) };
    });
  }

  /**
   * OFFICE capture — TWO-BRANCH (design §4.1, FR-HR-004):
   *   times present → punches → `insertPunches` → `reconcileDays`, then patch the day-level fields;
   *   no times      → patch/create the row directly, writing NO punches.
   *
   * Why two branches: a PAID_LEAVE or ABSENT day has no times, so it produces no punches and
   * reconciliation would create no row at all — and `paidDays` counts ROWS. Without the second branch
   * every leave day silently costs the employee a day's pay.
   *
   * Why through the pipeline at all: `attendance_record` used to have two independent writers with
   * contradictory rules — this path REJECTED a second row for the day while `reconcileDays` MERGED,
   * and reconciliation would overwrite a hand-keyed roster with a device punch. Now reconciliation is
   * the single writer of times, so a manual 09:05 and a device 18:10 merge into one correct day, and
   * an approved `day_status` survives a later punch (reconcile only sets it on create).
   *
   * Re-submitting the same day is therefore idempotent rather than a `DuplicateAttendanceError`: the
   * punch key `(company, user, deviceTimestamp)` and the day-unique partial index both absorb it.
   */
  private async captureOffice(rows: NewAttendance[], actor: Actor): Promise<{ ids: string[] }> {
    return this.uow.run(async () => {
      for (const row of rows) {
        const employeeId = requireField(row.employeeId, 'employeeId');
        const projectId = requireField(row.projectId, 'projectId');
        const attendanceDate = requireField(row.attendanceDate, 'attendanceDate');

        // Punches are keyed on the device ENROLMENT CODE, never the employee UUID — that is what
        // makes a hand-keyed row and a machine punch land on the same day.
        const code = await this.repo.findEmployeeCodeById(actor.companyId, employeeId);
        if (!code) throw new NotFoundError(`Employee ${employeeId} not found`);

        const punches: PunchToStore[] = [];
        for (const [time, status] of [
          [row.checkIn, '0'],
          [row.checkOut, '1'],
        ] as const) {
          const normalised = time == null ? null : normaliseTime(String(time));
          if (!normalised) continue;
          const deviceTimestamp = `${attendanceDate} ${normalised}`;
          punches.push({
            sourceType: 'MANUAL',
            userId: code,
            deviceTimestamp,
            status,
            occurredAt: parseDeviceTimestamp(deviceTimestamp),
            deviceSn: null,
            // The punch carries the SAME project as the row. `projectId` is required on an office row
            // (FR-HR-008; `attendance_record.project_id` is NOT NULL) and the UI's Location picker
            // always sends something explicit, so resolution rank 1 always wins for manual entry —
            // which is correct: the operator stated where this was. Never send null here hoping the
            // device default will cover it; that default is the HEAD-OFFICE machine's project and
            // would mis-tag a branch office with no machine of its own.
            projectId,
          });
        }

        if (punches.length > 0) {
          await this.punches.insertPunches(actor.companyId, punches);
          await this.punches.reconcileDays(actor.companyId, null, [
            { userId: code, attendanceDate },
          ]);
        }

        // Always patch: `dayStatus` and `overtimeHours` have no punch representation, and on a
        // timeless day this is what creates the row at all.
        await this.repo.patchOfficeDayFields(
          actor.companyId,
          actor.financialYearId,
          employeeId,
          attendanceDate,
          projectId,
          {
            dayStatus: String(row.dayStatus ?? 'PRESENT'),
            overtimeHours: String(row.overtimeHours ?? '0'),
          },
        );
      }

      // The RECONCILED row ids, not the ids of aggregates this path no longer creates: the response
      // shape is unchanged, and a caller that submitted rows needs to know which row each landed on.
      // The id is stable across resubmission because the day is unique per (company, employee, date).
      const ids = await this.repo.findOfficeRowIds(
        actor.companyId,
        rows.map((row) => ({
          employeeId: requireField(row.employeeId, 'employeeId'),
          attendanceDate: row.attendanceDate,
        })),
      );

      await this.audit.record({
        action: 'CREATE',
        entityType: ATTENDANCE_SOURCE_TYPE,
        entityId: ids.join(','),
        actorId: actor.userId,
        companyId: actor.companyId,
      });

      return { ids };
    });
  }

  /** Edit an UNCONFIRMED daily-labour row (FR-HR-006). A confirmed row is immutable. */
  async editDailyLabour(id: string, patch: EditDailyLabour, version: number, actor: Actor): Promise<void> {
    return this.uow.run(async () => {
      const rec = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!rec) throw new NotFoundError(`Attendance ${id} not found`);
      if (rec.isConfirmed) throw new AttendanceConfirmedImmutableError(id);
      rec.editDailyLabour(patch);
      await this.repo.save(rec, version);
    });
  }

  /**
   * THE ACCRUAL. Confirm a daily-labour row → post the DAILY_LABOUR_ACCRUAL via PostingService inside ONE
   * uow.run (design §5.1). Atomic: attendance state, journal entry + lines, NUM counter commit together or
   * roll back — a rejected post (closed period/project, imbalance) consumes NO number (FR-HR-018;
   * FR-LED-016/-020). A second concurrent confirm blocks on the row lock then fails assertUnconfirmed
   * (exactly one accrual, one number — edge §12.7).
   */
  async confirmDailyLabour(id: string, purposeId: string | undefined, actor: Actor): Promise<ConfirmResult> {
    return this.uow.run(async () => {
      const rec = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!rec) throw new NotFoundError(`Attendance ${id} not found`);
      rec.assertAccruable(); // DAILY_LABOUR only (subcontractor/office never post — FR-HR-005)
      rec.assertUnconfirmed(); // re-confirm rejected (edge §12.1)
      if (purposeId) rec.setPurpose(purposeId); // accrual matrix requires purpose (FR-HR-010)

      // Belt-and-braces closed-project guard (LED re-checks inside post — FR-HR-018).
      await this.projectStatus.assertNotClosed(actor.companyId, rec.props.projectId);

      const accts = await this.accounts.accrualAccounts(actor.companyId);
      const line = accrualLineFor(rec);
      const cmd = buildAccrualCommand(
        {
          companyId: actor.companyId,
          financialYearId: rec.props.financialYearId,
          accrualDate: rec.props.attendanceDate,
          sourceId: rec.id,
          postedBy: actor.userId,
          lines: [line],
        },
        accts,
      );
      const entry = await this.posting.post(cmd);

      rec.confirm(entry.id);
      await this.repo.save(rec, rec.version);

      // Write the LabourPayable rollup alongside the accrual (settled by PAY later — FR-HR-011).
      await this.payables.insert(
        LabourPayable.create(this.ids.next(), {
          companyId: actor.companyId,
          financialYearId: rec.props.financialYearId,
          projectId: rec.props.projectId,
          costCentreId: rec.props.costCentreId as string,
          accrualDate: rec.props.attendanceDate,
          accruedAmount: line.cost,
          accrualEntryId: entry.id,
        }),
      );

      await this.audit.record({
        action: 'POST',
        entityType: ATTENDANCE_SOURCE_TYPE,
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });

      return {
        attendanceId: rec.id,
        accrualEntryId: entry.id,
        entryNo: entry.props.entryNo,
        accruedAmount: line.cost.toFixed(),
        isConfirmed: true,
      };
    });
  }

  /**
   * Correct a confirmed accrual by reverse-and-repost (FR-HR-012). PostingService.reverse writes a NEW
   * swapped-side entry linked to the original via reversal_of; the original posted entry is never touched.
   */
  async reverseAccrual(id: string, reason: string, actor: Actor): Promise<ReverseResult> {
    return this.uow.run(async () => {
      const rec = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!rec) throw new NotFoundError(`Attendance ${id} not found`);
      if (!rec.isConfirmed || !rec.props.accrualEntryId) {
        throw new AttendanceNotConfirmedError(id);
      }
      const reversal = await this.posting.reverse(
        rec.props.accrualEntryId,
        actor.companyId,
        reason,
        actor.userId,
      );
      await this.audit.record({
        action: 'CANCEL',
        entityType: ATTENDANCE_SOURCE_TYPE,
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return {
        reversalEntryId: reversal.id,
        reversalEntryNo: reversal.props.entryNo,
        originalEntryId: rec.props.accrualEntryId,
      };
    });
  }

  /**
   * Consume a PAY settlement against labour-payable: roll up the LabourPayable (settled_amount/status)
   * WITHOUT re-posting (FR-HR-011; FR-PAY-005). The posted accrual entry is never touched. No-op if the
   * accrual entry is not one of HR's payables.
   */
  async applySettlement(
    companyId: string,
    accrualEntryId: string,
    amount: Money,
    actor?: Actor,
  ): Promise<void> {
    return this.uow.run(async () => {
      const payable = await this.payables.findByAccrualEntry(companyId, accrualEntryId);
      if (!payable) return; // not an HR labour payable — nothing to roll up
      payable.applySettlement(amount);
      await this.payables.save(payable, payable.version);
      if (actor) {
        await this.audit.record({
          action: 'UPDATE',
          entityType: 'LabourPayable',
          entityId: payable.id,
          actorId: actor.userId,
          companyId,
        });
      }
    });
  }
}
