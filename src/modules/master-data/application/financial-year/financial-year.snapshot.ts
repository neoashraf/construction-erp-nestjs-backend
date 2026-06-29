/** Plain before/after snapshot of a FinancialYear for the audit log (FR-MAS-031). */
import { FinancialYear } from '../../financial-year/domain/financial-year';

export function financialYearSnapshot(fy: FinancialYear): Record<string, unknown> {
  const p = fy.props;
  return {
    id: fy.id,
    companyId: p.companyId,
    label: p.label,
    startDate: p.startDate.value,
    endDate: p.endDate.value,
    isActive: p.isActive,
    version: p.version,
  };
}
