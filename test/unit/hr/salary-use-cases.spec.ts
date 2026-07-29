/**
 * SalaryService use-case unit tests (fake ports + fake UnitOfWork/Clock/IdGenerator). Cites FR-HR-013/-014/
 * -015/-018. Covers: post allowed only from DRAFT and posts exactly once inside the UoW with a balanced
 * command; INACTIVE employees excluded from generate (FR-HR-003); one-draft-per-period guard
 * (DuplicateDraftSheetError); closed-project rejection before write (no post call, no number consumed);
 * an imbalanced command is rejected by the fake PostingService (mirrors LED's real balance check); PAY
 * settlement never touches HR salary state (HR posts nothing on a payment event — mirrors
 * AttendanceService.applySettlement's own no-re-expense pattern; salary has no equivalent settlement
 * consumer in this brief's scope, so this is asserted as "post is never called outside post()/generate()").
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { ClosedProjectError, NotFoundError } from '../../../src/common/errors/domain-error';
import { JournalEntry } from '../../../src/core/posting/domain/journal-entry';
import { PostingCommand } from '../../../src/core/posting/domain/posting-command';
import { Employee } from '../../../src/modules/hr/domain/employee';
import { SalarySheet, SalarySheetLine } from '../../../src/modules/hr/domain/salary-sheet';
import { SalaryService } from '../../../src/modules/hr/application/salary.service';
import { DuplicateDraftSheetError, SalaryNotPostedError } from '../../../src/modules/hr/domain/errors';
import { OfficeAttendanceSummary } from '../../../src/modules/hr/domain/ports/attendance.repository';

const actor: Actor = {
  userId: 'u1',
  companyId: 'co1',
  financialYearId: 'fy1',
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const CLOCK = { now: () => new Date('2026-06-30T10:00:00Z') };
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };

function idGen() {
  let n = 0;
  return { next: () => `id-${++n}` };
}

function fakeEntry(cmd: PostingCommand, entryNo = 'SAL/2526/00001'): JournalEntry {
  return JournalEntry.create({ ...cmd, entryNo, lines: cmd.lines }, { next: () => 'entry-1' }, CLOCK);
}

const SALARY_ACCOUNTS = {
  grossSalary: 'acc-gross',
  employerPfContribution: 'acc-employer-pf',
  salaryPayable: 'acc-salary-payable',
  tdsPayable: 'acc-tds-payable',
  pfPayable: 'acc-pf-payable',
  staffAdvanceRecovery: 'acc-advance',
  labourCostCentreId: 'cc-labour',
};

function draftSheetWithOneLine(): SalarySheet {
  const line = SalarySheetLine.create('line-1', {
    employeeId: 'emp-1',
    projectId: 'p1',
    costCentreId: 'cc-labour',
    purposeId: 'pur1',
    paidDays: '30',
    gross: Money.of('50000'),
    components: { tds: '5000' },
  });
  return SalarySheet.generate(
    'sheet-1',
    'co1',
    { financialYearId: 'fy1', periodLabel: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30' },
    [line],
  );
}

function activeEmployee(id: string, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'): Employee {
  const emp = Employee.create(id, 'co1', {
    employeeCode: `EMP-${id}`,
    name: 'Test Employee',
    designation: 'Engineer',
    defaultProjectId: 'p1',
    workBase: 'SITE',
    wageType: 'MONTHLY',
    wageAmount: '45000',
    joiningDate: '2025-07-01',
  });
  if (status === 'INACTIVE') emp.deactivate();
  return emp;
}

function makeService(overrides: Partial<Record<string, unknown>> = {}) {
  const saved: SalarySheet[] = [];
  const inserted: SalarySheet[] = [];
  const postSpy = jest.fn(async (cmd: PostingCommand) => fakeEntry(cmd));
  const reverseSpy = jest.fn();

  const repo = {
    insert: async (s: SalarySheet) => void inserted.push(s),
    save: async (s: SalarySheet) => void saved.push(s),
    findById: async () => null,
    findByIdForUpdate: async () => draftSheetWithOneLine(),
    existsDraftForPeriod: async () => false,
    ...((overrides.repo as object) ?? {}),
  };
  const employees = {
    activeForCompany: async () => [activeEmployee('emp-1')],
    findById: async () => null,
    ...((overrides.employees as object) ?? {}),
  };
  const attendanceSummary: OfficeAttendanceSummary = {
    paidDays: '22',
    attendedDays: '22',
    overtimeHours: '0',
    primaryProjectId: 'p1',
  };
  const attendance = {
    summarizeOffice: async () => attendanceSummary,
    // The corrected rule reads the DAYS, not a rollup — a count cannot tell a working day with no
    // record apart from a holiday, which is the distinction the whole rule turns on.
    listOfficeDays: async () => [],
    ...((overrides.attendance as object) ?? {}),
  };
  const accounts = {
    salaryAccounts: async () => SALARY_ACCOUNTS,
    ...((overrides.accounts as object) ?? {}),
  };
  const projectStatus = {
    assertNotClosed: async () => undefined,
    ...((overrides.projectStatus as object) ?? {}),
  };
  const posting = {
    post: postSpy,
    reverse: reverseSpy,
    ...((overrides.posting as object) ?? {}),
  };

  const svc = new SalaryService(
    repo as never,
    employees as never,
    attendance as never,
    accounts as never,
    projectStatus as never,
    posting as never,
    // Attendance config: no `attendance_setting` row and no weekly holidays, so these tests exercise
    // the documented fallback (09:30 threshold, 3 lates per deducted day).
    ({
      findSetting: async () => null,
      listWeeklyHolidays: async () => [],
      listGovernmentHolidays: async () => [],
      ...((overrides.attendanceConfig as object) ?? {}),
    }) as never,
    audit as never,
    uow as never,
    idGen() as never,
    CLOCK as never,
  );
  return { svc, saved, inserted, postSpy, reverseSpy, repo };
}

describe('SalaryService.generate', () => {
  it('excludes INACTIVE employees (FR-HR-003)', async () => {
    const { svc, inserted } = makeService({
      employees: {
        activeForCompany: async () => [activeEmployee('emp-1'), activeEmployee('emp-2', 'INACTIVE')].filter(
          (e) => e.isActive,
        ),
      },
    });
    await svc.generate(
      { financialYearId: 'fy1', periodLabel: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30', purposeId: 'pur1' },
      actor,
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0].lines).toHaveLength(1);
    expect(inserted[0].lines[0].props.employeeId).toBe('emp-1');
  });

  it('rejects a second DRAFT for the same (financialYearId, periodLabel) — DUPLICATE_DRAFT_SHEET', async () => {
    const { svc } = makeService({ repo: { existsDraftForPeriod: async () => true } });
    await expect(
      svc.generate(
        { financialYearId: 'fy1', periodLabel: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30', purposeId: 'pur1' },
        actor,
      ),
    ).rejects.toBeInstanceOf(DuplicateDraftSheetError);
  });
});

describe('SalaryService.post', () => {
  it('posts exactly once inside the UoW with a balanced command; markPosted + save', async () => {
    const { svc, postSpy, saved } = makeService();
    const res = await svc.post('sheet-1', 1, actor);
    expect(postSpy).toHaveBeenCalledTimes(1);
    const cmd = postSpy.mock.calls[0][0] as PostingCommand;
    expect(cmd.voucherType).toBe('SALARY');
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.equals(cr)).toBe(true);
    expect(res.salaryEntryId).toBe('entry-1');
    expect(res.status).toBe('POSTED');
    expect(saved).toHaveLength(1);
    expect(saved[0].props.status).toBe('POSTED');
  });

  it('rejects a closed project BEFORE any post call (FR-HR-018) — no ledger write', async () => {
    const { svc, postSpy } = makeService({
      projectStatus: {
        assertNotClosed: async () => {
          throw new ClosedProjectError('p1');
        },
      },
    });
    await expect(svc.post('sheet-1', 1, actor)).rejects.toBeInstanceOf(ClosedProjectError);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('post() again on an already-POSTED sheet is rejected (SalaryNotDraftError) — mirrors AC2', async () => {
    const posted = draftSheetWithOneLine();
    posted.markPosted('entry-existing', 'u1', new Date());
    const { svc, postSpy } = makeService({ repo: { findByIdForUpdate: async () => posted } });
    await expect(svc.post('sheet-1', 1, actor)).rejects.toThrow();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('propagates an imbalanced-command rejection from PostingService (mirrors LED balance guard)', async () => {
    const { svc } = makeService({
      posting: {
        post: async () => {
          throw new Error('UNBALANCED_ENTRY');
        },
        reverse: jest.fn(),
      },
    });
    await expect(svc.post('sheet-1', 1, actor)).rejects.toThrow('UNBALANCED_ENTRY');
  });

  it('throws NotFoundError when the sheet does not exist', async () => {
    const { svc } = makeService({ repo: { findByIdForUpdate: async () => null } });
    await expect(svc.post('missing', 1, actor)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('SalaryService.reverse', () => {
  it('reverses a POSTED sheet via PostingService.reverse exactly once', async () => {
    const posted = draftSheetWithOneLine();
    posted.markPosted('entry-existing', 'u1', new Date());
    const reverseSpy = jest.fn(async () =>
      JournalEntry.create(
        {
          companyId: 'co1',
          financialYearId: 'fy1',
          voucherType: 'SALARY',
          voucherDate: '2026-06-30',
          sourceType: 'SalarySheet',
          sourceId: 'sheet-1',
          postedBy: 'u1',
          lines: [
            { accountId: 'acc-gross', debit: Money.zero(), credit: Money.of('50000') },
            { accountId: 'acc-salary-payable', debit: Money.of('50000'), credit: Money.zero() },
          ],
        } as never,
        { next: () => 'reversal-1' },
        CLOCK,
      ),
    );
    const { svc } = makeService({
      repo: { findByIdForUpdate: async () => posted },
      posting: { post: jest.fn(), reverse: reverseSpy },
    });
    const res = await svc.reverse('sheet-1', 'correction', actor);
    expect(reverseSpy).toHaveBeenCalledTimes(1);
    expect(reverseSpy).toHaveBeenCalledWith('entry-existing', 'co1', 'correction', 'u1');
    expect(res.originalEntryId).toBe('entry-existing');
    expect(res.status).toBe('REVERSED');
  });

  it('rejects reversing a DRAFT sheet (SalaryNotPostedError)', async () => {
    const { svc } = makeService();
    await expect(svc.reverse('sheet-1', 'x', actor)).rejects.toBeInstanceOf(SalaryNotPostedError);
  });
});

describe('SalaryService — no re-expense on PAY event', () => {
  it('generate()/editLine()/applyBulkComponents() never call PostingService.post', async () => {
    const { svc, postSpy } = makeService();
    await svc.generate(
      { financialYearId: 'fy1', periodLabel: '2026-07', periodStart: '2026-07-01', periodEnd: '2026-07-31', purposeId: 'pur1' },
      actor,
    );
    await svc.editLine('sheet-1', 'line-1', { tds: '100' }, 1, actor);
    await svc.applyBulkComponents('sheet-1', { allowances: '50' }, 1, actor);
    expect(postSpy).not.toHaveBeenCalled();
  });
});
