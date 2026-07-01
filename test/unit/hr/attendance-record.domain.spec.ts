/**
 * HR AttendanceRecord domain unit tests (no DB, no Nest). Covers the per-mode field invariants
 * (FR-HR-004/005/006/008), head-count×rate exact-decimal cost (FR-HR-010), the accruable-only rule
 * (subcontractor/office never accrue — FR-HR-005), re-confirm rejection (edge §12.1), and daily-labour
 * edit-while-unconfirmed only (FR-HR-006).
 */
import { Money } from '../../../src/common/money';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { AttendanceRecord } from '../../../src/modules/hr/domain/attendance-record';
import {
  AlreadyConfirmedError,
  NotAccruableModeError,
} from '../../../src/modules/hr/domain/errors';

const CO = 'co1';
const FY = 'fy1';

function dailyLabour(overrides: Record<string, unknown> = {}): AttendanceRecord {
  return AttendanceRecord.capture('a1', CO, FY, {
    mode: 'DAILY_LABOUR',
    attendanceDate: '2026-06-20',
    projectId: 'p1',
    costCentreId: 'cc-slab',
    purposeId: 'pur1',
    headCount: 20,
    dailyRate: '650',
    labourCategory: 'Mason',
    ...overrides,
  });
}

describe('AttendanceRecord — per-mode invariants', () => {
  it('OFFICE requires employeeId and forbids headCount/partyId (FR-HR-004/008)', () => {
    expect(() =>
      AttendanceRecord.capture('a', CO, FY, {
        mode: 'OFFICE',
        attendanceDate: '2026-06-20',
        projectId: 'p1',
        headCount: 3,
      } as never),
    ).toThrow(ValidationError);

    const ok = AttendanceRecord.capture('a', CO, FY, {
      mode: 'OFFICE',
      attendanceDate: '2026-06-20',
      projectId: 'p1',
      employeeId: 'e1',
      dayStatus: 'PRESENT',
    });
    expect(ok.props.employeeId).toBe('e1');
    expect(ok.props.headCount).toBeNull();
  });

  it('SUBCONTRACTOR requires partyId + costCentreId + headCount>=1 (FR-HR-005/008)', () => {
    expect(() =>
      AttendanceRecord.capture('a', CO, FY, {
        mode: 'SUBCONTRACTOR',
        attendanceDate: '2026-06-20',
        projectId: 'p1',
        costCentreId: 'cc1',
        headCount: 5,
      } as never),
    ).toThrow(/partyId/);

    const ok = AttendanceRecord.capture('a', CO, FY, {
      mode: 'SUBCONTRACTOR',
      attendanceDate: '2026-06-20',
      projectId: 'p1',
      costCentreId: 'cc1',
      partyId: 'party1',
      headCount: 5,
    });
    expect(ok.isAccruable).toBe(false);
  });

  it('DAILY_LABOUR requires costCentreId + headCount>=1 + dailyRate>=0 (FR-HR-006/008)', () => {
    expect(() => dailyLabour({ costCentreId: null })).toThrow(/costCentreId/);
    expect(() => dailyLabour({ headCount: 0 })).toThrow(/headCount/);
    expect(() => dailyLabour({ dailyRate: '-1' })).toThrow(/dailyRate/);
  });

  it('project is required in every mode (FR-HR-008)', () => {
    expect(() => dailyLabour({ projectId: '' })).toThrow(/projectId/);
  });
});

describe('AttendanceRecord — accrual math & lifecycle', () => {
  it('accruedCost = headCount × dailyRate, exact decimal (FR-HR-010)', () => {
    expect(dailyLabour().accruedCost().equals(Money.of('13000'))).toBe(true);
    expect(dailyLabour({ headCount: 12, dailyRate: '700' }).accruedCost().equals(Money.of('8400'))).toBe(
      true,
    );
    // no float drift on an awkward rate
    expect(
      dailyLabour({ headCount: 7, dailyRate: '123.4567' }).accruedCost().equals(Money.of('864.1969')),
    ).toBe(true);
  });

  it('only DAILY_LABOUR is accruable; subcontractor/office throw NotAccruableModeError (FR-HR-005)', () => {
    const sub = AttendanceRecord.capture('a', CO, FY, {
      mode: 'SUBCONTRACTOR',
      attendanceDate: '2026-06-20',
      projectId: 'p1',
      costCentreId: 'cc1',
      partyId: 'party1',
      headCount: 5,
    });
    expect(() => sub.confirm('entry-1')).toThrow(NotAccruableModeError);

    const office = AttendanceRecord.capture('a', CO, FY, {
      mode: 'OFFICE',
      attendanceDate: '2026-06-20',
      projectId: 'p1',
      employeeId: 'e1',
      dayStatus: 'PRESENT',
    });
    expect(() => office.confirm('entry-1')).toThrow(NotAccruableModeError);
  });

  it('confirm records the accrual entry id and marks CONFIRMED', () => {
    const rec = dailyLabour();
    rec.confirm('entry-42');
    expect(rec.isConfirmed).toBe(true);
    expect(rec.props.accrualEntryId).toBe('entry-42');
  });

  it('re-confirm is rejected (edge §12.1)', () => {
    const rec = dailyLabour();
    rec.confirm('entry-1');
    expect(() => rec.confirm('entry-2')).toThrow(AlreadyConfirmedError);
  });

  it('editDailyLabour only while unconfirmed', () => {
    const rec = dailyLabour();
    rec.editDailyLabour({ headCount: 25 });
    expect(rec.props.headCount).toBe(25);
    rec.confirm('entry-1');
    expect(() => rec.editDailyLabour({ headCount: 30 })).toThrow(AlreadyConfirmedError);
  });
});
