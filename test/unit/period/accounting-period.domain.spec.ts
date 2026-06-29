/**
 * AccountingPeriod domain unit tests (no DB/Nest) — FSM transitions + stamps + inclusive boundary
 * resolution (FR-PER-001/005/008/009, design §3.1, §9).
 */
import { AccountingPeriod } from '../../../src/core/period/domain/accounting-period';
import { DateOnly } from '../../../src/common/value-objects/date-only';
import {
  PeriodAlreadyClosedError,
  PeriodAlreadyOpenError,
} from '../../../src/core/period/domain/errors';
import { Clock } from '../../../src/common/ports/clock.port';

const clock: Clock = { now: () => new Date('2026-07-15T10:00:00Z') };

function jul2025(): AccountingPeriod {
  return AccountingPeriod.create('p-1', {
    companyId: 'co-1',
    financialYearId: 'fy-1',
    name: 'Jul 2025',
    startDate: DateOnly.of('2025-07-01'),
    endDate: DateOnly.of('2025-07-31'),
  });
}

describe('AccountingPeriod (domain)', () => {
  it('creates OPEN at version 1 with no close stamps', () => {
    const p = jul2025();
    expect(p.isOpen()).toBe(true);
    expect(p.props.closedAt).toBeNull();
    expect(p.props.closedBy).toBeNull();
    expect(p.version).toBe(1);
  });

  it('owns dates within [start, end] inclusive, and not outside (boundary rule)', () => {
    const p = jul2025();
    expect(p.owns('2025-07-01')).toBe(true);
    expect(p.owns('2025-07-31')).toBe(true); // inclusive end (edge case 9)
    expect(p.owns('2025-06-30')).toBe(false);
    expect(p.owns('2025-08-01')).toBe(false);
  });

  it('close() OPEN→CLOSED stamps closedAt/closedBy', () => {
    const p = jul2025();
    p.close('user-7', clock);
    expect(p.isOpen()).toBe(false);
    expect(p.props.closedBy).toBe('user-7');
    expect(p.props.closedAt).toEqual(new Date('2026-07-15T10:00:00Z'));
  });

  it('close() on a CLOSED period throws PeriodAlreadyClosedError', () => {
    const p = jul2025();
    p.close('user-7', clock);
    expect(() => p.close('user-7', clock)).toThrow(PeriodAlreadyClosedError);
  });

  it('reopen() CLOSED→OPEN clears stamps; reopen() on OPEN throws', () => {
    const p = jul2025();
    p.close('user-7', clock);
    p.reopen();
    expect(p.isOpen()).toBe(true);
    expect(p.props.closedAt).toBeNull();
    expect(p.props.closedBy).toBeNull();
    expect(() => p.reopen()).toThrow(PeriodAlreadyOpenError);
  });
});
