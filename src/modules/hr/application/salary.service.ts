/**
 * SalaryService — generate() + post() [posts SALARY] + reverse() + per-line/bulk component edits (design
 * §5.2, FR-HR-013..018). Mirrors AttendanceService.confirmDailyLabour's shape for `post`:
 *   generate() — no ledger impact. Builds a DRAFT sheet from ACTIVE employees' office attendance for the
 *     period (INACTIVE excluded — FR-HR-003); rejects a second DRAFT for the same
 *     (financialYearId, periodLabel) with DuplicateDraftSheetError (edge §12.4). Pure calculation
 *     (SalaryCalculator) — no PostingService call.
 *   editLine()/applyBulkComponents() — DRAFT-only per-employee / bulk allowance-deduction edits, recomputed
 *     totals (FR-HR-014).
 *   post() — THE SALARY POSTING. Inside ONE uow.run: row-lock the draft, assert DRAFT, resolve the six
 *     salary accounts + the Labour cost centre (MAS), compute the employer-PF-per-line map (matched 1:1 to
 *     the line's own employee-PF deduction for employees with `pfApplicable=true` — design §4(b)'s worked
 *     employee-PF-25,000/employer-PF-25,000 figures), build the balanced SALARY command (design §4(b)) and
 *     call the REAL PostingService.post through HR's own PostingServicePort (period→project→tags→refs→
 *     balance→NUMBER-last→write), markPosted(entry.id) — atomic (FR-LED-016). A rejected post (closed
 *     period/project, imbalance) consumes NO number (FR-HR-018; FR-LED-018/-019/-020).
 *   reverse() — correct a POSTED run by reverse-and-repost through PostingService (FR-HR-012/-018). The
 *     sheet's stored `status` column is NEVER flipped to a 'REVERSED' literal — design §3 makes REVERSED a
 *     DERIVED read (see salary-sheet.ts's header); this service does not compute the derived status either
 *     — that is SalaryQueryService's job (read side) so the write-side aggregate stays pure of read-model
 *     concerns.
 * HR builds NO journal row itself and opens no transaction of its own beyond this uow.run (CLAUDE.md #1/#2).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { AttendanceSummary, calcGross, EmployeePayInfo } from '../domain/salary-calculator';
import { computePayrollDays, penaltyDays } from '../domain/payroll-days';
import {
  BulkApplyComponents,
  EditSalaryLineComponents,
  NewSalarySheet,
  PrePostWarnings,
  SALARY_SHEET_SOURCE_TYPE,
  SalarySheet,
  SalarySheetLine,
} from '../domain/salary-sheet';
import { buildSalaryCommand } from '../domain/salary-command.factory';
import { DuplicateDraftSheetError, SalaryNotPostedError } from '../domain/errors';
import { ATTENDANCE_REPOSITORY, AttendanceRepository } from '../domain/ports/attendance.repository';
import { EMPLOYEE_REPOSITORY, EmployeeRepository } from '../domain/ports/employee.repository';
import { SALARY_SHEET_REPOSITORY, SalarySheetRepository } from '../domain/ports/salary-sheet.repository';
import {
  HR_ACCOUNT_RESOLVER_PORT,
  HrAccountResolverPort,
} from '../domain/ports/hr-account-resolver.port';
import { HR_PROJECT_STATUS_PORT, HrProjectStatusPort } from '../domain/ports/project-status.port';
import { POSTING_SERVICE_PORT, PostingServicePort } from '../domain/ports/posting.service.port';
import {
  ATTENDANCE_CONFIG_REPOSITORY,
  AttendanceConfigRepository,
} from '../attendance-reports/domain/ports/attendance-config.repository';
import { buildWeeklyHolidayDateSet } from '../attendance-reports/domain/attendance-rules';

/**
 * Used when the company has no `attendance_setting` row. Mirrors the reports' fallback exactly — if
 * these ever diverged, a report and a salary sheet would disagree about which days were late for an
 * un-configured company (FR-HR-008c).
 */
const DEFAULT_LATE_THRESHOLD = { lateAfterHour: 9, lateAfterMinute: 30, latesPerDeductedDay: 3 };

export interface GenerateSalaryInput {
  financialYearId: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  projectId?: string;
  /**
   * The Purpose tag applied to every generated line (the accrual/salary matrix requires purpose —
   * FR-HR-015). Purpose is a project-scoped MAS master with no company-wide default (unlike the CoA),
   * so the caller supplies it explicitly at generate time; a per-line PATCH can override afterwards.
   * Additive to the API contract's documented generate body (backward compatible — optional).
   */
  purposeId: string;
}

/**
 * `generate` returns the warnings as well as the id, because the FR-HR-013a guard is only useful
 * before posting. They are ALSO persisted on the sheet — the generator is frequently not the poster,
 * and warnings that live only in this response let a two-person handoff bypass the guard entirely.
 */
export interface GenerateSalaryResult {
  id: string;
  warnings: PrePostWarnings;
}

export interface PostSalaryResult {
  salarySheetId: string;
  salaryEntryId: string;
  entryNo: string;
  status: 'POSTED';
}

export interface ReverseSalaryResult {
  reversalEntryId: string;
  reversalEntryNo: string;
  originalEntryId: string;
  status: 'REVERSED';
}

@Injectable()
export class SalaryService {
  constructor(
    @Inject(SALARY_SHEET_REPOSITORY) private readonly repo: SalarySheetRepository,
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepository,
    @Inject(ATTENDANCE_REPOSITORY) private readonly attendance: AttendanceRepository,
    @Inject(HR_ACCOUNT_RESOLVER_PORT) private readonly accounts: HrAccountResolverPort,
    @Inject(HR_PROJECT_STATUS_PORT) private readonly projectStatus: HrProjectStatusPort,
    @Inject(POSTING_SERVICE_PORT) private readonly posting: PostingServicePort,
    @Inject(ATTENDANCE_CONFIG_REPOSITORY) private readonly attendanceConfig: AttendanceConfigRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Generate (or attempt to regenerate) a DRAFT sheet for a period from ACTIVE employees' office
   * attendance + wage type + overtime (FR-HR-013/-014). INACTIVE employees are excluded (FR-HR-003). A
   * DRAFT already existing for the same (financialYearId, periodLabel) is rejected — edit it instead
   * (edge §12.4). No ledger impact — pure calculation only.
   */
  async generate(input: GenerateSalaryInput, actor: Actor): Promise<GenerateSalaryResult> {
    return this.uow.run(async () => {
      if (await this.repo.existsDraftForPeriod(actor.companyId, input.financialYearId, input.periodLabel)) {
        throw new DuplicateDraftSheetError(input.financialYearId, input.periodLabel);
      }

      const employees = await this.employees.activeForCompany(actor.companyId, input.projectId);
      const salaryCostCentreId = await this.resolveLabourCostCentre(actor.companyId);

      // Config is loaded ONCE per generate, not per employee: the holiday calendar and the threshold
      // are company-wide, and re-reading them per employee would be N round-trips for one answer.
      const setting = await this.attendanceConfig.findSetting(actor.companyId);
      const lateThreshold = {
        lateAfterHour: setting?.lateAfterHour ?? DEFAULT_LATE_THRESHOLD.lateAfterHour,
        lateAfterMinute: setting?.lateAfterMinute ?? DEFAULT_LATE_THRESHOLD.lateAfterMinute,
      };
      const latesPerDeductedDay =
        setting?.latesPerDeductedDay ?? DEFAULT_LATE_THRESHOLD.latesPerDeductedDay;

      const weeklyHolidayWeekdays = await this.attendanceConfig.listWeeklyHolidays(actor.companyId);
      const holidayDates = await this.resolveHolidayDates(
        actor.companyId,
        input.periodStart,
        input.periodEnd,
        weeklyHolidayWeekdays,
      );

      const lines: SalarySheetLine[] = [];
      const skippedEmployees: Array<{ employeeId: string; reason: string }> = [];
      const employeeAbsences: Array<{ employeeId: string; unpaidDays: number }> = [];
      const missingByDate = new Map<string, number>();

      for (const emp of employees) {
        const summary = await this.attendance.summarizeOffice(
          actor.companyId,
          emp.id,
          input.periodStart,
          input.periodEnd,
        );
        const days = await this.attendance.listOfficeDays(
          actor.companyId,
          emp.id,
          input.periodStart,
          input.periodEnd,
        );

        const payrollDays = computePayrollDays({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          employmentStart: emp.props.joiningDate,
          // `Employee` has no exit date — a leaver is INACTIVE, and `activeForCompany` already
          // excludes INACTIVE employees from generation (FR-HR-003). So there is no end to clip to.
          employmentEnd: null,
          days,
          holidayDates,
          lateThreshold,
        });

        const forfeited = penaltyDays(payrollDays.lateDays, latesPerDeductedDay);
        const payInfo: EmployeePayInfo = { wageType: emp.props.wageType, wageAmount: emp.props.wageAmount };
        const attSummary: AttendanceSummary = {
          paidDays: String(payrollDays.paidDays),
          standardDays: String(payrollDays.standardDays),
          attendedDays: String(payrollDays.attendedDays),
          overtimeAmount: '0', // overtime HOURS are captured; Phase-1 rate config is pending client (design §10)
          penaltyDays: String(forfeited),
        };
        const gross = calcGross(payInfo, attSummary);

        // What the penalty cost, so the payslip explains itself without re-deriving from the rate.
        // Zero for DAILY, whose gross ignores the penalty entirely (FR-HR-013a's final clause).
        const latePenaltyAmount =
          emp.props.wageType === 'MONTHLY' && forfeited > 0
            ? calcGross(payInfo, { ...attSummary, penaltyDays: '0' }).minus(gross)
            : Money.zero();

        const projectId = summary.primaryProjectId ?? emp.props.defaultProjectId;
        if (!projectId) {
          // Was a bare `continue`: an employee with no attendance and no default project simply
          // vanished from the sheet and was not paid, with no error anywhere. Still skipped — the
          // line has nothing to tag — but now VISIBLE (FR-HR-013a, design §8.2(d)).
          skippedEmployees.push({ employeeId: emp.id, reason: 'NO_PROJECT' });
          continue;
        }

        for (const date of payrollDays.missingDays) {
          missingByDate.set(date, (missingByDate.get(date) ?? 0) + 1);
        }
        employeeAbsences.push({ employeeId: emp.id, unpaidDays: payrollDays.unpaidDays });

        lines.push(
          SalarySheetLine.create(this.ids.next(), {
            employeeId: emp.id,
            projectId,
            costCentreId: salaryCostCentreId,
            purposeId: input.purposeId,
            paidDays: String(payrollDays.paidDays),
            gross,
            standardDays: String(payrollDays.standardDays),
            unpaidDays: String(payrollDays.unpaidDays),
            lateCount: payrollDays.lateDays,
            latePenaltyDays: String(forfeited),
            latePenaltyAmount,
          }),
        );
      }

      // A day is a COMPANY-WIDE gap only when every employee on the sheet reports it missing — one
      // person's absence is not a device outage, and conflating the two would cry wolf every month.
      const generatedCount = lines.length;
      const daysWithNoRecords = [...missingByDate.entries()]
        .filter(([, count]) => generatedCount > 0 && count === generatedCount)
        .map(([date]) => date)
        .sort();

      const warnings: PrePostWarnings = {
        daysWithNoRecords,
        skippedEmployees,
        employeeAbsences,
        // The one payroll defect the report-vs-payroll cross-check CANNOT catch: both sides read the
        // same empty config and therefore agree, while every employee is docked for every weekend.
        // A brand-new tenant lands here without touching a setting.
        noWeeklyHolidaysConfigured: weeklyHolidayWeekdays.length === 0,
      };

      const sheet = SalarySheet.generate(
        this.ids.next(),
        actor.companyId,
        {
          financialYearId: input.financialYearId,
          periodLabel: input.periodLabel,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        } as NewSalarySheet,
        lines,
        warnings,
      );
      await this.repo.insert(sheet);
      await this.audit.record({
        action: 'CREATE',
        entityType: SALARY_SHEET_SOURCE_TYPE,
        entityId: sheet.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id: sheet.id, warnings };
    });
  }

  /** Per-employee component edit on a DRAFT line (FR-HR-014). Recomputes that line + the sheet totals. */
  async editLine(
    sheetId: string,
    lineId: string,
    patch: EditSalaryLineComponents,
    version: number,
    actor: Actor,
  ): Promise<void> {
    return this.uow.run(async () => {
      const sheet = await this.repo.findByIdForUpdate(sheetId, actor.companyId);
      if (!sheet) throw new NotFoundError(`Salary sheet ${sheetId} not found`);
      sheet.editLine(lineId, patch);
      await this.repo.save(sheet, version);
      await this.audit.record({
        action: 'UPDATE',
        entityType: SALARY_SHEET_SOURCE_TYPE,
        entityId: sheetId,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }

  /** Bulk-apply allowance/deduction defaults across a DRAFT sheet's lines, optionally scoped by employeeId. */
  async applyBulkComponents(
    sheetId: string,
    rule: BulkApplyComponents,
    version: number,
    actor: Actor,
  ): Promise<void> {
    return this.uow.run(async () => {
      const sheet = await this.repo.findByIdForUpdate(sheetId, actor.companyId);
      if (!sheet) throw new NotFoundError(`Salary sheet ${sheetId} not found`);
      sheet.applyBulkComponents(rule);
      await this.repo.save(sheet, version);
      await this.audit.record({
        action: 'UPDATE',
        entityType: SALARY_SHEET_SOURCE_TYPE,
        entityId: sheetId,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }

  /**
   * THE SALARY POSTING. Post a DRAFT sheet → the balanced SALARY entry via PostingService inside ONE
   * uow.run (design §5.2). Atomic: sheet state, journal entry + lines, NUM counter commit together or roll
   * back — a rejected post consumes NO number (FR-HR-018; FR-LED-016/-020).
   */
  async post(sheetId: string, version: number, actor: Actor): Promise<PostSalaryResult> {
    return this.uow.run(async () => {
      const sheet = await this.repo.findByIdForUpdate(sheetId, actor.companyId);
      if (!sheet) throw new NotFoundError(`Salary sheet ${sheetId} not found`);
      sheet.assertPostable(); // DRAFT only

      // Belt-and-braces closed-project guard per line's project (LED re-checks inside post — FR-HR-018).
      const checked = new Set<string>();
      for (const line of sheet.lines) {
        if (checked.has(line.props.projectId)) continue;
        checked.add(line.props.projectId);
        await this.projectStatus.assertNotClosed(actor.companyId, line.props.projectId);
      }

      const accts = await this.accounts.salaryAccounts(actor.companyId);
      const employerPfByLine = await this.computeEmployerPf(sheet.lines, actor.companyId);
      const cmd = buildSalaryCommand(sheet, accts, {
        companyId: actor.companyId,
        financialYearId: sheet.props.financialYearId,
        voucherDate: sheet.props.periodEnd,
        sourceId: sheet.id,
        postedBy: actor.userId,
        employerPfByLine,
      });
      const entry = await this.posting.post(cmd);

      sheet.markPosted(entry.id, actor.userId, this.clock.now());
      await this.repo.save(sheet, version);

      await this.audit.record({
        action: 'POST',
        entityType: SALARY_SHEET_SOURCE_TYPE,
        entityId: sheetId,
        actorId: actor.userId,
        companyId: actor.companyId,
      });

      return {
        salarySheetId: sheet.id,
        salaryEntryId: entry.id,
        entryNo: entry.props.entryNo,
        status: 'POSTED',
      };
    });
  }

  /**
   * Correct a POSTED run by reverse-and-repost (FR-HR-012/-018). PostingService.reverse writes a NEW
   * swapped-side entry linked to the original via reversal_of; the original posted entry is never touched.
   * The sheet's stored status column stays 'POSTED' — REVERSED is a derived read (design §3).
   */
  async reverse(sheetId: string, reason: string, actor: Actor): Promise<ReverseSalaryResult> {
    return this.uow.run(async () => {
      const sheet = await this.repo.findByIdForUpdate(sheetId, actor.companyId);
      if (!sheet) throw new NotFoundError(`Salary sheet ${sheetId} not found`);
      if (sheet.props.status !== 'POSTED' || !sheet.props.salaryEntryId) {
        throw new SalaryNotPostedError(sheetId);
      }
      const reversal = await this.posting.reverse(
        sheet.props.salaryEntryId,
        actor.companyId,
        reason,
        actor.userId,
      );
      await this.audit.record({
        action: 'CANCEL',
        entityType: SALARY_SHEET_SOURCE_TYPE,
        entityId: sheetId,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return {
        reversalEntryId: reversal.id,
        reversalEntryNo: reversal.props.entryNo,
        originalEntryId: sheet.props.salaryEntryId,
        status: 'REVERSED',
      };
    });
  }

  /**
   * Weekly + government holidays for the period, merged into one date set.
   *
   * Merged into a Set on purpose: a government holiday falling on a weekly holiday must count ONCE,
   * or the baseline would lose a day and everyone would be short-paid for it. A period spanning a
   * year boundary needs both calendar years, since `listGovernmentHolidays` is per-year.
   */
  private async resolveHolidayDates(
    companyId: string,
    periodStart: string,
    periodEnd: string,
    weeklyHolidayWeekdays: readonly number[],
  ): Promise<Set<string>> {
    const dates: string[] = [];
    const cursor = new Date(`${periodStart}T00:00:00Z`);
    const last = new Date(`${periodEnd}T00:00:00Z`);
    while (cursor <= last) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const years = [...new Set([periodStart.slice(0, 4), periodEnd.slice(0, 4)])];
    const government: string[] = [];
    for (const year of years) {
      const rows = await this.attendanceConfig.listGovernmentHolidays(companyId, Number(year));
      government.push(...rows.map((row) => row.date));
    }

    const inPeriod = new Set(dates);
    return new Set([
      ...buildWeeklyHolidayDateSet(dates, weeklyHolidayWeekdays),
      ...government.filter((date) => inPeriod.has(date)),
    ]);
  }

  private async resolveLabourCostCentre(companyId: string): Promise<string> {
    const accts = await this.accounts.salaryAccounts(companyId);
    return accts.labourCostCentreId;
  }

  /**
   * Employer PF contribution per line, matched 1:1 to the employee's own PF deduction (design §4(b)'s
   * worked figures: employee PF 25,000 / employer PF 25,000 — an equal-match convention) for employees
   * with `pfApplicable=true`. Employees with PF not applicable contribute nothing on either side.
   */
  private async computeEmployerPf(lines: SalarySheet['lines'], companyId: string): Promise<Map<string, Money>> {
    const map = new Map<string, Money>();
    for (const line of lines) {
      const emp = await this.employees.findById(line.props.employeeId, companyId);
      if (emp?.props.pfApplicable) {
        map.set(line.id, line.props.pf);
      }
    }
    return map;
  }
}

/** Inclusive calendar-day count between two 'YYYY-MM-DD' dates (the period's standard working-day basis). */

