/**
 * `generate`'s pre-post warnings (FR-HR-013a) — fake ports, no DB, no Nest.
 *
 * These are NOT polish. Under the corrected rule a working day with no attendance record DEDUCTS, so
 * one week of device downtime silently removes a week's pay from every head-office employee — and the
 * first person to notice is the employee. The warnings are the only thing standing between a data gap
 * and an underpaid payroll run.
 *
 * The key names are pinned deliberately. `pre_post_warnings` is `jsonb`: nothing in the schema fails
 * if one is renamed, the column accepts it happily, and the UI just quietly stops rendering a warning
 * that exists in the data.
 */
import { Money } from '../../../src/common/money';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { Employee } from '../../../src/modules/hr/domain/employee';
import { SalarySheet } from '../../../src/modules/hr/domain/salary-sheet';
import { SalaryService } from '../../../src/modules/hr/application/salary.service';
import { OfficeDayRow } from '../../../src/modules/hr/domain/payroll-days';

const actor: Actor = {
  userId: 'u1',
  companyId: 'co1',
  financialYearId: 'fy1',
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const CLOCK = { now: () => new Date('2026-07-31T10:00:00Z') };
const uow = { run: <T>(work: () => Promise<T>) => work() };

/** July 2026: 31 days, Fridays on the 3rd, 10th, 17th, 24th and 31st. */
const PERIOD = {
  financialYearId: 'fy1',
  periodLabel: '2026-07',
  periodStart: '2026-07-01',
  periodEnd: '2026-07-31',
  purposeId: 'pur1',
};
const FRIDAY = 5;

function idGen() {
  let n = 0;
  return { next: () => `id-${++n}` };
}

function employee(id: string, defaultProjectId: string | null = 'p1'): Employee {
  return Employee.create(id, 'co1', {
    employeeCode: `EMP-${id}`,
    name: 'Test Employee',
    designation: 'Officer',
    defaultProjectId,
    workBase: 'HEAD_OFFICE',
    wageType: 'MONTHLY',
    wageAmount: '31000',
    joiningDate: '2025-07-01',
  });
}

function present(date: string): OfficeDayRow {
  return { attendanceDate: date, dayStatus: 'PRESENT', checkIn: '09:00:00', projectId: 'p1', overtimeHours: '0' };
}

/** Every working day of July except the dates given. */
function julyExcept(...skip: string[]): OfficeDayRow[] {
  const holidays = new Set(['2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24', '2026-07-31']);
  const days: OfficeDayRow[] = [];
  for (let d = 1; d <= 31; d += 1) {
    const date = `2026-07-${String(d).padStart(2, '0')}`;
    if (holidays.has(date) || skip.includes(date)) continue;
    days.push(present(date));
  }
  return days;
}

interface Options {
  employees?: Employee[];
  daysByEmployee?: Record<string, OfficeDayRow[]>;
  weeklyHolidays?: number[];
  primaryProjectId?: string | null;
}

function build(options: Options = {}) {
  const inserted: SalarySheet[] = [];
  const employeeList = options.employees ?? [employee('emp-1')];

  const svc = new SalaryService(
    {
      insert: async (s: SalarySheet) => void inserted.push(s),
      existsDraftForPeriod: async () => false,
    } as never,
    { activeForCompany: async () => employeeList } as never,
    {
      summarizeOffice: async () => ({
        paidDays: '0',
        attendedDays: '0',
        overtimeHours: '0',
        primaryProjectId:
          options.primaryProjectId === undefined ? 'p1' : options.primaryProjectId,
      }),
      listOfficeDays: async (_c: string, employeeId: string) =>
        options.daysByEmployee?.[employeeId] ?? julyExcept(),
    } as never,
    { salaryAccounts: async () => ({ labourCostCentreId: 'cc-labour' }) } as never,
    { assertNotClosed: async () => undefined } as never,
    { post: jest.fn(), reverse: jest.fn() } as never,
    {
      findSetting: async () => ({
        lateAfterHour: 9,
        lateAfterMinute: 30,
        latesPerDeductedDay: 3,
        updatedAt: null,
      }),
      listWeeklyHolidays: async () => options.weeklyHolidays ?? [FRIDAY],
      listGovernmentHolidays: async () => [],
    } as never,
    { record: async () => undefined } as never,
    uow as never,
    idGen() as never,
    CLOCK as never,
  );

  return { svc, inserted };
}

describe('generate — pre-post warnings (FR-HR-013a)', () => {
  it('persists exactly the four warning keys the contract specifies', async () => {
    // Contractual — see api-contracts/12-hr-payroll.md and SRS §8 SalarySheet. `jsonb` will accept a
    // typo silently, so the key SET is what this pins.
    const { svc, inserted } = build();

    const result = await svc.generate(PERIOD, actor);

    expect(Object.keys(result.warnings).sort()).toEqual([
      'daysWithNoRecords',
      'employeeAbsences',
      'noWeeklyHolidaysConfigured',
      'skippedEmployees',
    ]);
    // Stored on the sheet too, not just returned: the poster is frequently not the generator.
    expect(inserted[0]?.props.prePostWarnings).toEqual(result.warnings);
  });

  it('reports a working day on which NOBODY has a record', async () => {
    // A company-wide gap — a device outage or an unsubmitted branch log — not two coincidental absences.
    const { svc } = build({
      employees: [employee('emp-1'), employee('emp-2')],
      daysByEmployee: {
        'emp-1': julyExcept('2026-07-07'),
        'emp-2': julyExcept('2026-07-07'),
      },
    });

    const { warnings } = await svc.generate(PERIOD, actor);

    expect(warnings.daysWithNoRecords).toEqual(['2026-07-07']);
  });

  it('does NOT report a day only one employee is missing — that is an absence, not an outage', async () => {
    // Conflating the two would cry wolf every month and train the poster to click through.
    const { svc } = build({
      employees: [employee('emp-1'), employee('emp-2')],
      daysByEmployee: {
        'emp-1': julyExcept('2026-07-07'),
        'emp-2': julyExcept(),
      },
    });

    const { warnings } = await svc.generate(PERIOD, actor);

    expect(warnings.daysWithNoRecords).toEqual([]);
    expect(warnings.employeeAbsences).toEqual([
      { employeeId: 'emp-1', unpaidDays: 1 },
      { employeeId: 'emp-2', unpaidDays: 0 },
    ]);
  });

  it('reports an employee skipped for want of a project instead of dropping them silently', async () => {
    // This was a bare `continue`: the employee vanished from the sheet and was not paid, with no
    // error anywhere. Combined with a device-created employee who has no default project, the chain
    // ended in someone simply not being paid.
    const { svc, inserted } = build({
      employees: [employee('emp-no-project', null)],
      primaryProjectId: null,
    });

    const { warnings } = await svc.generate(PERIOD, actor);

    expect(warnings.skippedEmployees).toEqual([
      { employeeId: 'emp-no-project', reason: 'NO_PROJECT' },
    ]);
    expect(inserted[0]?.lines).toHaveLength(0); // still skipped — but now visible
  });

  it('fires noWeeklyHolidaysConfigured on an empty weekly-holiday config', async () => {
    // The ONE payroll defect the report-vs-payroll cross-check cannot catch: both sides read the same
    // empty config and therefore AGREE, while every employee is docked for every Friday. A brand-new
    // tenant lands in this state without anyone touching a setting.
    const { svc } = build({ weeklyHolidays: [] });

    const { warnings } = await svc.generate(PERIOD, actor);

    expect(warnings.noWeeklyHolidaysConfigured).toBe(true);
  });

  it('leaves the flag false once a weekly holiday is configured', async () => {
    const { svc } = build({ weeklyHolidays: [FRIDAY] });

    expect((await svc.generate(PERIOD, actor)).warnings.noWeeklyHolidaysConfigured).toBe(false);
  });

  it('pays a full working month in full, and stores the day figures on the line', async () => {
    // ⭐ The end-to-end form of the assertion whose absence let the 26/31 defect ship.
    const { svc, inserted } = build();

    await svc.generate(PERIOD, actor);
    const line = inserted[0]?.lines[0];

    expect(line?.props.standardDays.toFixed()).toBe('31.0000');
    expect(line?.props.unpaidDays.toFixed()).toBe('0.0000');
    expect(line?.props.paidDays.toFixed()).toBe('31.0000');
    expect(line?.props.grossAmount.equals(Money.of('31000'))).toBe(true);
    expect(line?.props.lateCount).toBe(0);
    expect(line?.props.latePenaltyDays.toFixed()).toBe('0.0000');
    expect(line?.props.latePenaltyAmount.toFixed()).toBe('0.0000');
  });

  it('stores the late penalty and what it cost, so the payslip can explain itself', async () => {
    // Six lates at 3-per-day = 2 forfeited days: 31,000 × (31 − 2)/31 = 29,000.
    const days = julyExcept().map((day, index) =>
      index < 6 ? { ...day, checkIn: '09:45:00' } : day,
    );
    const { svc, inserted } = build({ daysByEmployee: { 'emp-1': days } });

    await svc.generate(PERIOD, actor);
    const line = inserted[0]?.lines[0];

    expect(line?.props.lateCount).toBe(6);
    expect(line?.props.latePenaltyDays.toFixed()).toBe('2.0000');
    expect(line?.props.grossAmount.toFixed()).toBe('29000.0000');
    expect(line?.props.latePenaltyAmount.toFixed()).toBe('2000.0000');
  });
});
