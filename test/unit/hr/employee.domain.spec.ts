/**
 * HR Employee domain unit tests (no DB, no Nest). Cites FR-HR-001/-002/-003. Covers wage validation,
 * append-only reassignment (returns a new history row; effective-date guard), and the ACTIVE/INACTIVE
 * lifecycle. Also LabourPayable rollup math (FR-HR-011).
 */
import { Money } from '../../../src/common/money';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { Employee } from '../../../src/modules/hr/domain/employee';
import { LabourPayable } from '../../../src/modules/hr/domain/labour-payable';
import { EffectiveDateBeforeJoiningError } from '../../../src/modules/hr/domain/errors';

function newEmployee(overrides: Record<string, unknown> = {}): Employee {
  return Employee.create('e1', 'co1', {
    employeeCode: 'EMP-014',
    name: 'মোঃ রফিকুল ইসলাম',
    designation: 'Site Accountant',
    defaultProjectId: 'p1',
    workBase: 'SITE',
    wageType: 'MONTHLY',
    wageAmount: '45000',
    joiningDate: '2024-03-01',
    tin: '123456789012',
    ...overrides,
  });
}

describe('Employee — office-staff master', () => {
  it('creates ACTIVE with version 1; preserves Bangla name; validates TIN', () => {
    const e = newEmployee();
    expect(e.props.status).toBe('ACTIVE');
    expect(e.version).toBe(1);
    expect(e.props.name).toBe('মোঃ রফিকুল ইসলাম');
    expect(e.props.tin).toBe('123456789012');
    expect(e.isActive).toBe(true);
  });

  it('rejects negative wage and bad TIN', () => {
    expect(() => newEmployee({ wageAmount: '-1' })).toThrow(ValidationError);
    expect(() => newEmployee({ tin: '123' })).toThrow(ValidationError);
  });

  it('reassign appends a history row, sets the new default project, never before joining (FR-HR-002)', () => {
    const e = newEmployee();
    const a = e.reassign('as1', 'p2', '2024-05-01', 'moved to Site B');
    expect(e.props.defaultProjectId).toBe('p2');
    expect(a.props.projectId).toBe('p2');
    expect(a.props.effectiveDate).toBe('2024-05-01');
    expect(a.props.employeeId).toBe('e1');
    // effective date before joining is rejected
    expect(() => e.reassign('as2', 'p3', '2024-01-01', null)).toThrow(EffectiveDateBeforeJoiningError);
  });

  it('deactivate/reactivate flip status (FR-HR-003)', () => {
    const e = newEmployee();
    e.deactivate();
    expect(e.isActive).toBe(false);
    expect(e.props.status).toBe('INACTIVE');
    e.reactivate();
    expect(e.isActive).toBe(true);
  });
});

describe('LabourPayable — settlement rollup (FR-HR-011)', () => {
  function payable(): LabourPayable {
    return LabourPayable.create('lp1', {
      companyId: 'co1',
      financialYearId: 'fy1',
      projectId: 'p1',
      costCentreId: 'cc1',
      accrualDate: '2026-06-20',
      accruedAmount: Money.of('21400'),
      accrualEntryId: 'entry-1',
    });
  }

  it('starts OUTSTANDING with zero settled', () => {
    const lp = payable();
    expect(lp.props.status).toBe('OUTSTANDING');
    expect(lp.props.settledAmount.equals(Money.zero())).toBe(true);
  });

  it('partial then full settlement rolls up status; caps at accrued', () => {
    const lp = payable();
    lp.applySettlement(Money.of('10000'));
    expect(lp.props.status).toBe('PARTIALLY_SETTLED');
    lp.applySettlement(Money.of('11400'));
    expect(lp.props.status).toBe('SETTLED');
    expect(lp.props.settledAmount.equals(Money.of('21400'))).toBe(true);
    // an over-payment never pushes settled past accrued
    lp.applySettlement(Money.of('500'));
    expect(lp.props.settledAmount.equals(Money.of('21400'))).toBe(true);
  });
});
