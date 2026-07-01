/**
 * LabourPayableMapper (INFRASTRUCTURE) — LabourPayable aggregate ↔ `labour_payable` ORM row. Exact money.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../common/money';
import { LabourPayable, LabourPayableStatus } from '../domain/labour-payable';
import { LabourPayableOrmEntity } from './labour-payable.orm-entity';

export const LabourPayableMapper = {
  toOrm(lp: LabourPayable): LabourPayableOrmEntity {
    const p = lp.props;
    const row = new LabourPayableOrmEntity();
    row.id = lp.id;
    row.companyId = p.companyId;
    row.financialYearId = p.financialYearId;
    row.projectId = p.projectId;
    row.costCentreId = p.costCentreId;
    row.accrualDate = p.accrualDate;
    row.accruedAmount = p.accruedAmount.amount;
    row.accrualEntryId = p.accrualEntryId;
    row.settledAmount = p.settledAmount.amount;
    row.status = p.status;
    return row;
  },

  toDomain(r: LabourPayableOrmEntity): LabourPayable {
    return LabourPayable.rehydrate(r.id, {
      companyId: r.companyId,
      financialYearId: r.financialYearId,
      projectId: r.projectId,
      costCentreId: r.costCentreId,
      accrualDate: r.accrualDate,
      accruedAmount: Money.of(new Decimal(r.accruedAmount)),
      accrualEntryId: r.accrualEntryId,
      settledAmount: Money.of(new Decimal(r.settledAmount)),
      status: r.status as LabourPayableStatus,
      version: r.version,
    });
  },
};
