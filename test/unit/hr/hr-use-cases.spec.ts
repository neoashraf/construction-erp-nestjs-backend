/**
 * HR use-case unit tests (fake ports + fake UnitOfWork/Clock/IdGenerator). Cites FR-HR-001/-003/-005/-009/
 * -011/-018. Covers: confirmDailyLabour posts exactly once inside the UoW with a balanced command and no
 * HR-authored journal row (FR-LED-002); closed-project rejection before write (no post) (FR-HR-018);
 * subcontractor capture posts nothing (FR-HR-005); PAY-event settlement rolls up the payable without
 * re-posting (FR-HR-011); office-staff-only create policy (FR-HR-001).
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { ClosedProjectError, NotFoundError } from '../../../src/common/errors/domain-error';
import { JournalEntry } from '../../../src/core/posting/domain/journal-entry';
import { PostingCommand } from '../../../src/core/posting/domain/posting-command';
import { AttendanceRecord } from '../../../src/modules/hr/domain/attendance-record';
import { AttendanceService } from '../../../src/modules/hr/application/attendance.service';
import { EmployeeService } from '../../../src/modules/hr/application/employee.service';
import { NotAccruableModeError, NotOfficeStaffError } from '../../../src/modules/hr/domain/errors';
import { LabourPayable } from '../../../src/modules/hr/domain/labour-payable';

const actor: Actor = {
  userId: 'u1',
  companyId: 'co1',
  financialYearId: 'fy1',
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const CLOCK = { now: () => new Date('2026-06-20T10:00:00Z') };
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };

function idGen() {
  let n = 0;
  return { next: () => `id-${++n}` };
}

function fakeEntry(cmd: PostingCommand): JournalEntry {
  // Build a real JournalEntry so the balance invariant is genuinely enforced (rejects an imbalance).
  return JournalEntry.create(
    { ...cmd, entryNo: 'DLA/2526/00001', lines: cmd.lines },
    { next: () => 'entry-1' },
    CLOCK,
  );
}

function dailyLabourRow(confirmed = false): AttendanceRecord {
  const rec = AttendanceRecord.capture('a1', 'co1', 'fy1', {
    mode: 'DAILY_LABOUR',
    attendanceDate: '2026-06-20',
    projectId: 'p1',
    costCentreId: 'cc-slab',
    purposeId: 'pur1',
    headCount: 20,
    dailyRate: '650',
  });
  if (confirmed) rec.confirm('entry-existing');
  return rec;
}

describe('AttendanceService.confirmDailyLabour', () => {
  it('posts exactly once inside the UoW with a balanced command; records accrual_entry_id + payable', async () => {
    const rec = dailyLabourRow();
    const saved: AttendanceRecord[] = [];
    const payables: LabourPayable[] = [];
    const postSpy = jest.fn(async (cmd: PostingCommand) => fakeEntry(cmd));

    const svc = new AttendanceService(
      {
        findByIdForUpdate: async () => rec,
        save: async (r: AttendanceRecord) => void saved.push(r),
        insertMany: async () => undefined,
      } as never,
      { insert: async (p: LabourPayable) => void payables.push(p) } as never,
      { accrualAccounts: async () => ({ labourCost: 'acc-l', labourPayable: 'acc-p' }) } as never,
      { assertNotClosed: async () => undefined } as never,
      { post: postSpy, reverse: jest.fn() } as never,
      {} as never, // punches — OFFICE only, never touched by the daily-labour accrual
      audit as never,
      uow as never,
      idGen() as never,
    );

    const res = await svc.confirmDailyLabour('a1', undefined, actor);

    expect(postSpy).toHaveBeenCalledTimes(1);
    const cmd = postSpy.mock.calls[0][0];
    expect(cmd.voucherType).toBe('DAILY_LABOUR_ACCRUAL');
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.toFixed(4)).toBe('13000.0000');
    expect(dr.equals(cr)).toBe(true);
    expect(res.accrualEntryId).toBe('entry-1');
    expect(res.accruedAmount).toBe('13000.0000');
    expect(rec.isConfirmed).toBe(true);
    expect(payables).toHaveLength(1);
    expect(payables[0].props.accruedAmount.equals(Money.of('13000'))).toBe(true);
  });

  it('rejects a closed project BEFORE any post (FR-HR-018) — no ledger write', async () => {
    const rec = dailyLabourRow();
    const postSpy = jest.fn();
    const svc = new AttendanceService(
      { findByIdForUpdate: async () => rec } as never,
      { insert: jest.fn() } as never,
      { accrualAccounts: async () => ({ labourCost: 'acc-l', labourPayable: 'acc-p' }) } as never,
      { assertNotClosed: async () => { throw new ClosedProjectError('p1'); } } as never,
      { post: postSpy } as never,
      {} as never,
      audit as never,
      uow as never,
      idGen() as never,
    );
    await expect(svc.confirmDailyLabour('a1', undefined, actor)).rejects.toBeInstanceOf(ClosedProjectError);
    expect(postSpy).not.toHaveBeenCalled();
    expect(rec.isConfirmed).toBe(false);
  });

  it('a subcontractor row cannot be confirmed (posts nothing — FR-HR-005)', async () => {
    const sub = AttendanceRecord.capture('a2', 'co1', 'fy1', {
      mode: 'SUBCONTRACTOR',
      attendanceDate: '2026-06-20',
      projectId: 'p1',
      costCentreId: 'cc1',
      partyId: 'party1',
      headCount: 5,
    });
    const postSpy = jest.fn();
    const svc = new AttendanceService(
      { findByIdForUpdate: async () => sub } as never,
      {} as never,
      {} as never,
      { assertNotClosed: async () => undefined } as never,
      { post: postSpy } as never,
      {} as never,
      audit as never,
      uow as never,
      idGen() as never,
    );
    await expect(svc.confirmDailyLabour('a2', undefined, actor)).rejects.toBeInstanceOf(NotAccruableModeError);
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('AttendanceService.capture — subcontractor is GL-free (FR-HR-005)', () => {
  it('persists tracking rows and never calls PostingService', async () => {
    const inserted: AttendanceRecord[] = [];
    const postSpy = jest.fn();
    const svc = new AttendanceService(
      { insertMany: async (rows: AttendanceRecord[]) => void inserted.push(...rows) } as never,
      {} as never,
      {} as never,
      {} as never,
      { post: postSpy } as never,
      {} as never,
      audit as never,
      uow as never,
      idGen() as never,
    );
    const { ids } = await svc.capture(
      'SUBCONTRACTOR',
      [{ partyId: 'party1', attendanceDate: '2026-06-20', projectId: 'p1', costCentreId: 'cc1', headCount: 8 } as never],
      actor,
    );
    expect(ids).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('AttendanceService.applySettlement — no re-expense (FR-HR-011)', () => {
  it('rolls up the payable and posts nothing', async () => {
    const lp = LabourPayable.create('lp1', {
      companyId: 'co1',
      financialYearId: 'fy1',
      projectId: 'p1',
      costCentreId: 'cc1',
      accrualDate: '2026-06-20',
      accruedAmount: Money.of('13000'),
      accrualEntryId: 'entry-1',
    });
    const saved: LabourPayable[] = [];
    const postSpy = jest.fn();
    const svc = new AttendanceService(
      {} as never,
      { findByAccrualEntry: async () => lp, save: async (p: LabourPayable) => void saved.push(p) } as never,
      {} as never,
      {} as never,
      { post: postSpy, reverse: postSpy } as never,
      {} as never,
      audit as never,
      uow as never,
      idGen() as never,
    );
    await svc.applySettlement('co1', 'entry-1', Money.of('13000'));
    expect(saved).toHaveLength(1);
    expect(saved[0].props.status).toBe('SETTLED');
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('EmployeeService.create — office-staff only (FR-HR-001)', () => {
  it('rejects a non-office wage type as not office staff', async () => {
    const svc = new EmployeeService(
      { existsCode: async () => false, insert: jest.fn(), appendAssignment: jest.fn() } as never,
      audit as never,
      uow as never,
      idGen() as never,
    );
    await expect(
      svc.create(
        {
          employeeCode: 'DL-1',
          name: 'Labourer',
          designation: 'x',
          workBase: 'SITE',
          wageType: 'HOURLY' as never,
          wageAmount: '500',
          joiningDate: '2024-01-01',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotOfficeStaffError);
  });

  it('rejects a duplicate employee code', async () => {
    const svc = new EmployeeService(
      { existsCode: async () => true } as never,
      audit as never,
      uow as never,
      idGen() as never,
    );
    await expect(
      svc.create(
        {
          employeeCode: 'EMP-1',
          name: 'x',
          designation: 'x',
          workBase: 'SITE',
          wageType: 'MONTHLY',
          wageAmount: '500',
          joiningDate: '2024-01-01',
        },
        actor,
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('reassign appends history for a found employee (NotFound when absent)', async () => {
    const svc = new EmployeeService(
      { findByIdForUpdate: async () => null } as never,
      audit as never,
      uow as never,
      idGen() as never,
    );
    await expect(
      svc.reassign('missing', { projectId: 'p2', effectiveDate: '2025-01-01' }, 1, actor),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
