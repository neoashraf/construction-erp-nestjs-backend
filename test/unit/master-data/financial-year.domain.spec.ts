/**
 * FinancialYear domain entity unit tests (no DB, no Nest) — FR-MAS-002, FR-MAS-003.
 * Guards: `end_date > start_date`, inactive-on-create, range re-check on edit, activate/deactivate.
 */
import { FinancialYear } from '../../../src/modules/master-data/financial-year/domain/financial-year';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';

const ids: IdGenerator = { next: () => 'fy-1' };
const BASE = { companyId: 'co-1', label: '2025-26', startDate: '2025-07-01', endDate: '2026-06-30' };

describe('FinancialYear (domain)', () => {
  it('creates inactive with version 1 (FR-MAS-002/003)', () => {
    const fy = FinancialYear.create(BASE, ids);
    expect(fy.id).toBe('fy-1');
    expect(fy.isActive).toBe(false);
    expect(fy.version).toBe(1);
    expect(fy.props.startDate.value).toBe('2025-07-01');
    expect(fy.props.endDate.value).toBe('2026-06-30');
  });

  it('rejects end_date <= start_date (SRS §11)', () => {
    expect(() => FinancialYear.create({ ...BASE, endDate: '2025-07-01' }, ids)).toThrow(ValidationError);
    expect(() => FinancialYear.create({ ...BASE, endDate: '2025-06-30' }, ids)).toThrow(ValidationError);
  });

  it('rejects a malformed date', () => {
    expect(() => FinancialYear.create({ ...BASE, startDate: '2025-13-40' }, ids)).toThrow(ValidationError);
  });

  it('update re-checks the range when a bound moves', () => {
    const fy = FinancialYear.create(BASE, ids);
    expect(() => fy.update({ endDate: '2025-01-01' })).toThrow(ValidationError);
    fy.update({ label: '2025-2026', endDate: '2026-12-31' });
    expect(fy.props.label).toBe('2025-2026');
    expect(fy.props.endDate.value).toBe('2026-12-31');
  });

  it('activate / deactivate toggles the active flag', () => {
    const fy = FinancialYear.create(BASE, ids);
    fy.activate();
    expect(fy.isActive).toBe(true);
    fy.deactivate();
    expect(fy.isActive).toBe(false);
  });
});
