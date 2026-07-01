/**
 * AttendanceService — three-mode capture (bulk-capable) + the ONE posting in this half: the daily-labour
 * accrual at head-count confirmation (design §5.1, FR-HR-004..012). Capture of OFFICE / SUBCONTRACTOR /
 * DAILY_LABOUR rows persists tracking data and posts NOTHING (subcontractor is GL-free — FR-HR-005).
 * `confirmDailyLabour` is the only ledger-touching path: inside ONE uow.run it row-locks the row, guards
 * DAILY_LABOUR + unconfirmed, resolves the labour accounts (MAS), builds the balanced DAILY_LABOUR_ACCRUAL
 * command and calls the REAL PostingService.post (period→project→tags→refs→balance→NUMBER-last→write),
 * records the accrual_entry_id + writes the LabourPayable, and marks CONFIRMED — all atomic (FR-LED-016).
 * `reverseAccrual` corrects a confirmed accrual by PostingService.reverse (append-only; FR-HR-012).
 * `applySettlement` consumes a PAY settlement to roll up the payable WITHOUT re-posting (FR-HR-011).
 * HR builds NO journal row itself and opens no transaction of its own (CLAUDE.md non-negotiable 2).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
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
  DuplicateAttendanceError,
} from '../domain/errors';
import { ATTENDANCE_REPOSITORY, AttendanceRepository } from '../domain/ports/attendance.repository';
import {
  LABOUR_PAYABLE_REPOSITORY,
  LabourPayableRepository,
} from '../domain/ports/labour-payable.repository';
import {
  BIOMETRIC_IMPORT_PORT,
  BiometricFeed,
  BiometricImportPort,
} from '../domain/ports/biometric-import.port';
import { EMPLOYEE_REPOSITORY, EmployeeRepository } from '../domain/ports/employee.repository';
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

export interface BiometricImportResult {
  imported: number;
  reconciled: number;
  conflicts: Array<{ employeeId: string; attendanceDate: string; reason: string }>;
}

@Injectable()
export class AttendanceService {
  constructor(
    @Inject(ATTENDANCE_REPOSITORY) private readonly repo: AttendanceRepository,
    @Inject(LABOUR_PAYABLE_REPOSITORY) private readonly payables: LabourPayableRepository,
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepository,
    @Inject(HR_ACCOUNT_RESOLVER_PORT) private readonly accounts: HrAccountResolverPort,
    @Inject(HR_PROJECT_STATUS_PORT) private readonly projectStatus: HrProjectStatusPort,
    @Inject(POSTING_SERVICE_PORT) private readonly posting: PostingServicePort,
    @Inject(BIOMETRIC_IMPORT_PORT) private readonly biometric: BiometricImportPort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /** Capture one or more attendance rows of a given mode (bulk, FR-HR-007). No ledger impact. */
  async capture(mode: AttendanceMode, rows: NewAttendance[], actor: Actor): Promise<{ ids: string[] }> {
    return this.uow.run(async () => {
      const records: AttendanceRecord[] = [];
      for (const row of rows) {
        const rec = AttendanceRecord.capture(this.ids.next(), actor.companyId, actor.financialYearId, {
          ...row,
          mode,
        });
        // OFFICE: reconcile to one row per employee per day — a conflicting same-day row is surfaced,
        // never silently doubled (edge §12.9).
        if (mode === 'OFFICE') {
          const existing = await this.repo.findOfficeRow(
            actor.companyId,
            rec.props.employeeId as string,
            rec.props.attendanceDate,
          );
          if (existing) {
            throw new DuplicateAttendanceError(rec.props.employeeId as string, rec.props.attendanceDate);
          }
        }
        records.push(rec);
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
   * Biometric import (CSV/XLSX or device-API payload) reconciled to one OFFICE row per employee per day
   * (FR-HR-004, edge §12.9). Rows whose day already has an OFFICE row are reported as conflicts (never
   * silently doubled); unknown employee codes are reported as conflicts too.
   */
  async importBiometric(
    feed: BiometricFeed,
    projectId: string,
    actor: Actor,
  ): Promise<BiometricImportResult> {
    const parsed = await this.biometric.parse(feed);
    return this.uow.run(async () => {
      const conflicts: BiometricImportResult['conflicts'] = [];
      const toInsert: AttendanceRecord[] = [];
      for (const row of parsed) {
        const employee = await this.employees.findByCode(actor.companyId, row.employeeCode);
        if (!employee) {
          conflicts.push({
            employeeId: row.employeeCode,
            attendanceDate: row.attendanceDate,
            reason: 'UNKNOWN_EMPLOYEE_CODE',
          });
          continue;
        }
        const existing = await this.repo.findOfficeRow(actor.companyId, employee.id, row.attendanceDate);
        if (existing) {
          conflicts.push({
            employeeId: employee.id,
            attendanceDate: row.attendanceDate,
            reason: 'ALREADY_RECORDED',
          });
          continue;
        }
        toInsert.push(
          AttendanceRecord.capture(this.ids.next(), actor.companyId, actor.financialYearId, {
            mode: 'OFFICE',
            attendanceDate: row.attendanceDate,
            projectId,
            employeeId: employee.id,
            checkIn: row.checkIn ?? null,
            checkOut: row.checkOut ?? null,
            dayStatus: row.dayStatus ?? 'PRESENT',
            overtimeHours: row.overtimeHours ?? '0',
            source: 'BIOMETRIC_IMPORT',
          }),
        );
      }
      if (toInsert.length) await this.repo.insertMany(toInsert);
      return { imported: parsed.length, reconciled: toInsert.length, conflicts };
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
