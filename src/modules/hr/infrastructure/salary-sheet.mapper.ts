/**
 * SalarySheetMapper (INFRASTRUCTURE) — SalarySheet/SalarySheetLine aggregate ↔ ORM rows. The domain never
 * imports TypeORM; this is the only seam. Money ↔ Decimal is exact via the ORM transformer.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../common/money';
import { SalarySheet, SalarySheetLine, SalarySheetStatus } from '../domain/salary-sheet';
import { SalarySheetOrmEntity } from './salary-sheet.orm-entity';
import { SalarySheetLineOrmEntity } from './salary-sheet-line.orm-entity';

export const SalarySheetMapper = {
  toOrm(sheet: SalarySheet): SalarySheetOrmEntity {
    const p = sheet.props;
    const row = new SalarySheetOrmEntity();
    row.id = sheet.id;
    row.companyId = p.companyId;
    row.financialYearId = p.financialYearId;
    row.periodLabel = p.periodLabel;
    row.periodStart = p.periodStart;
    row.periodEnd = p.periodEnd;
    row.status = p.status;
    row.salaryEntryId = p.salaryEntryId;
    row.postedAt = p.postedAt;
    row.postedBy = p.postedBy;
    return row;
  },

  lineToOrm(sheetId: string, line: SalarySheetLine): SalarySheetLineOrmEntity {
    const p = line.props;
    const row = new SalarySheetLineOrmEntity();
    row.id = line.id;
    row.salarySheetId = sheetId;
    row.employeeId = p.employeeId;
    row.projectId = p.projectId;
    row.costCentreId = p.costCentreId;
    row.purposeId = p.purposeId;
    row.paidDays = p.paidDays.amount;
    row.grossAmount = p.grossAmount.amount;
    row.allowances = p.allowances.amount;
    row.tds = p.tds.amount;
    row.pf = p.pf.amount;
    row.advanceRecovery = p.advanceRecovery.amount;
    row.otherDeductions = p.otherDeductions.amount;
    row.netAmount = p.netAmount.amount;
    return row;
  },

  toDomain(row: SalarySheetOrmEntity, lineRows: SalarySheetLineOrmEntity[]): SalarySheet {
    return SalarySheet.rehydrate(
      row.id,
      {
        companyId: row.companyId,
        financialYearId: row.financialYearId,
        periodLabel: row.periodLabel,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        status: row.status as SalarySheetStatus,
        salaryEntryId: row.salaryEntryId,
        postedAt: row.postedAt,
        postedBy: row.postedBy,
        version: row.version,
      },
      lineRows.map((r) => SalarySheetMapper.lineToDomain(r)),
    );
  },

  lineToDomain(r: SalarySheetLineOrmEntity): SalarySheetLine {
    return SalarySheetLine.rehydrate(r.id, {
      employeeId: r.employeeId,
      projectId: r.projectId,
      costCentreId: r.costCentreId,
      purposeId: r.purposeId,
      paidDays: Money.of(new Decimal(r.paidDays)),
      grossAmount: Money.of(new Decimal(r.grossAmount)),
      allowances: Money.of(new Decimal(r.allowances)),
      tds: Money.of(new Decimal(r.tds)),
      pf: Money.of(new Decimal(r.pf)),
      advanceRecovery: Money.of(new Decimal(r.advanceRecovery)),
      otherDeductions: Money.of(new Decimal(r.otherDeductions)),
      netAmount: Money.of(new Decimal(r.netAmount)),
      version: r.version,
    });
  },
};
