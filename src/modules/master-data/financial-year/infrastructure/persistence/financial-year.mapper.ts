/** Maps FinancialYear (domain) ↔ FinancialYearOrmEntity (persistence). INFRASTRUCTURE. */
import { DateOnly } from '../../../../../common/value-objects/date-only';
import { FinancialYear } from '../../domain/financial-year';
import { FinancialYearOrmEntity } from './financial-year.orm-entity';

export const FinancialYearMapper = {
  toDomain(row: FinancialYearOrmEntity): FinancialYear {
    return FinancialYear.rehydrate(row.id, {
      companyId: row.companyId,
      label: row.label,
      startDate: DateOnly.of(row.startDate),
      endDate: DateOnly.of(row.endDate),
      isActive: row.isActive,
      version: row.version,
    });
  },

  toInsert(fy: FinancialYear): FinancialYearOrmEntity {
    const p = fy.props;
    const row = new FinancialYearOrmEntity();
    row.id = fy.id;
    row.companyId = p.companyId;
    row.label = p.label;
    row.startDate = p.startDate.value;
    row.endDate = p.endDate.value;
    row.isActive = p.isActive;
    return row;
  },

  toUpdateSet(fy: FinancialYear): Record<string, unknown> {
    const p = fy.props;
    return {
      label: p.label,
      startDate: p.startDate.value,
      endDate: p.endDate.value,
      isActive: p.isActive,
    };
  },
};
