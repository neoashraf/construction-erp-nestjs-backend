/** Maps AccountingPeriod (domain) ↔ AccountingPeriodOrmEntity (persistence). INFRASTRUCTURE. */
import { DateOnly } from '../../../common/value-objects/date-only';
import { AccountingPeriod, PeriodStatus } from '../domain/accounting-period';
import { AccountingPeriodOrmEntity } from './accounting-period.orm-entity';

export const AccountingPeriodMapper = {
  toDomain(row: AccountingPeriodOrmEntity): AccountingPeriod {
    return AccountingPeriod.rehydrate(row.id, {
      companyId: row.companyId,
      financialYearId: row.financialYearId,
      name: row.name,
      startDate: DateOnly.of(row.startDate),
      endDate: DateOnly.of(row.endDate),
      status: row.status as PeriodStatus,
      closedAt: row.closedAt,
      closedBy: row.closedBy,
      version: row.version,
    });
  },

  toInsert(p: AccountingPeriod): AccountingPeriodOrmEntity {
    const props = p.props;
    const row = new AccountingPeriodOrmEntity();
    row.id = p.id;
    row.companyId = props.companyId;
    row.financialYearId = props.financialYearId;
    row.name = props.name;
    row.startDate = props.startDate.value;
    row.endDate = props.endDate.value;
    row.status = props.status;
    row.closedAt = props.closedAt;
    row.closedBy = props.closedBy;
    return row;
  },

  toUpdateSet(p: AccountingPeriod): Record<string, unknown> {
    const props = p.props;
    return {
      status: props.status,
      closedAt: props.closedAt,
      closedBy: props.closedBy,
    };
  },
};
