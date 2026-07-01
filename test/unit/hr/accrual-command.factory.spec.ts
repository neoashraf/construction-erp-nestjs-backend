/**
 * HR accrual-command.factory unit tests (no DB, no Nest). Cites FR-HR-009/-010. Proves the design §4(a)
 * worked template: Slab 20×৳650 + Brickwork 12×৳700 → balanced DAILY_LABOUR_ACCRUAL at ৳21,400 = ৳21,400
 * (exact Decimal); Dr labour cost / Cr labour-payable; every line carries project + cost_centre + purpose;
 * NO godown; NO party (aggregate liability, Phase 1).
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { AttendanceRecord } from '../../../src/modules/hr/domain/attendance-record';
import {
  accrualLineFor,
  buildAccrualCommand,
} from '../../../src/modules/hr/domain/accrual-command.factory';

const ACCOUNTS = { labourCost: 'acc-labour', labourPayable: 'acc-payable' };

function sum(lines: { debit: Money; credit: Money }[]): { dr: Decimal; cr: Decimal } {
  return lines.reduce(
    (s, l) => ({ dr: s.dr.plus(l.debit.amount), cr: s.cr.plus(l.credit.amount) }),
    { dr: new Decimal(0), cr: new Decimal(0) },
  );
}

describe('buildAccrualCommand — design §4(a)', () => {
  const slab = AttendanceRecord.capture('a-slab', 'co1', 'fy1', {
    mode: 'DAILY_LABOUR',
    attendanceDate: '2026-06-20',
    projectId: 'P-01',
    costCentreId: 'CC-Slab',
    purposeId: 'PUR-Slab',
    headCount: 20,
    dailyRate: '650',
  });
  const brick = AttendanceRecord.capture('a-brick', 'co1', 'fy1', {
    mode: 'DAILY_LABOUR',
    attendanceDate: '2026-06-20',
    projectId: 'P-01',
    costCentreId: 'CC-Brickwork',
    purposeId: 'PUR-Brick',
    headCount: 12,
    dailyRate: '700',
  });

  it('balances at exactly 21,400 as exact Decimal (FR-HR-010)', () => {
    const cmd = buildAccrualCommand(
      {
        companyId: 'co1',
        financialYearId: 'fy1',
        accrualDate: '2026-06-20',
        sourceId: 'run-1',
        postedBy: 'u1',
        lines: [accrualLineFor(slab), accrualLineFor(brick)],
      },
      ACCOUNTS,
    );
    const { dr, cr } = sum(cmd.lines);
    expect(dr.toFixed(4)).toBe('21400.0000');
    expect(cr.toFixed(4)).toBe('21400.0000');
    expect(dr.equals(cr)).toBe(true);
    expect(cmd.voucherType).toBe('DAILY_LABOUR_ACCRUAL');
  });

  it('Dr labour cost / Cr labour-payable; every line tagged project+cost_centre+purpose, no godown/party', () => {
    const cmd = buildAccrualCommand(
      {
        companyId: 'co1',
        financialYearId: 'fy1',
        accrualDate: '2026-06-20',
        sourceId: 'run-1',
        postedBy: 'u1',
        lines: [accrualLineFor(slab), accrualLineFor(brick)],
      },
      ACCOUNTS,
    );
    for (const l of cmd.lines) {
      expect(l.projectId).toBe('P-01');
      expect(l.costCentreId).toBeTruthy();
      expect(l.purposeId).toBeTruthy();
      expect(l.godownId).toBeUndefined();
      expect(l.partyId).toBeUndefined();
    }
    const debits = cmd.lines.filter((l) => l.debit.amount.greaterThan(0));
    const credits = cmd.lines.filter((l) => l.credit.amount.greaterThan(0));
    expect(debits.every((l) => l.accountId === 'acc-labour')).toBe(true);
    expect(credits.every((l) => l.accountId === 'acc-payable')).toBe(true);
    expect(debits).toHaveLength(2);
    expect(credits).toHaveLength(2);
  });

  it('single-cost-centre entry produces one balanced Dr/Cr pair', () => {
    const cmd = buildAccrualCommand(
      {
        companyId: 'co1',
        financialYearId: 'fy1',
        accrualDate: '2026-06-20',
        sourceId: 'a-slab',
        postedBy: 'u1',
        lines: [accrualLineFor(slab)],
      },
      ACCOUNTS,
    );
    expect(cmd.lines).toHaveLength(2);
    const { dr, cr } = sum(cmd.lines);
    expect(dr.toFixed(4)).toBe('13000.0000');
    expect(cr.equals(dr)).toBe(true);
  });
});
