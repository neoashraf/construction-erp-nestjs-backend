/**
 * RPT report query DTOs (PRESENTATION · FR-RPT-002/§11) — class-validator, camelCase. Company is implicit
 * from the JWT (never a param). Money/dates are strings. `format` ∈ json|excel|pdf (default json — this
 * brief implements the JSON exporter only). Period/as-of (`periodId`/`asOf`) takes precedence over a date
 * range on balance reports, mirroring LED's trial balance.
 */
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Min } from 'class-validator';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toNum = ({ value }: { value: unknown }) => (value === undefined ? undefined : Number(value));

export const REPORT_FORMATS = ['json', 'excel', 'pdf'] as const;

class ReportPaging {
  @IsOptional() @Transform(toNum) @IsInt() @Min(1) page?: number;
  @IsOptional() @Transform(toNum) @IsInt() @Min(1) pageSize?: number;
}

class CommonReportQueryDto extends ReportPaging {
  @IsUUID() financialYearId!: string;
  @IsOptional() @IsIn(REPORT_FORMATS) format?: (typeof REPORT_FORMATS)[number];
  @IsOptional() @IsUUID() projectId?: string;
}

export class TrialBalanceReportQueryDto extends CommonReportQueryDto {
  @IsOptional() @IsUUID() periodId?: string;
  @IsOptional() @Matches(ISO) asOf?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
  @IsOptional() @IsString() groupBy?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @IsUUID() purposeId?: string;
  @IsOptional() @IsUUID() godownId?: string;
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @IsUUID() accountId?: string;
}

export class AccountLedgerReportQueryDto extends CommonReportQueryDto {
  @IsUUID() accountId!: string;
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}

export class DaybookReportQueryDto extends CommonReportQueryDto {
  @Matches(ISO) dateFrom!: string;
  @Matches(ISO) dateTo!: string;
  @IsOptional() @IsString() voucherType?: string;
}

export class CashBankBookReportQueryDto extends CommonReportQueryDto {
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}

export class ProfitAndLossReportQueryDto extends CommonReportQueryDto {
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
  @IsOptional() @IsString() groupBy?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
}

export class BalanceSheetReportQueryDto extends CommonReportQueryDto {
  @IsOptional() @IsUUID() periodId?: string;
  @IsOptional() @Matches(ISO) asOf?: string;
}

// ── Inventory reports (FR-RPT-021…023) — financialYearId optional (stock is a live projection) ──────
const MONTH = /^\d{4}-\d{2}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

export class StockValuationReportQueryDto extends ReportPaging {
  @IsOptional() @IsIn(REPORT_FORMATS) format?: (typeof REPORT_FORMATS)[number];
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsUUID() godownId?: string;
  @IsOptional() @IsUUID() itemId?: string;
  @IsOptional() @Matches(ISO) asOf?: string;
}

export class LowStockReportQueryDto extends ReportPaging {
  @IsOptional() @IsIn(REPORT_FORMATS) format?: (typeof REPORT_FORMATS)[number];
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsUUID() godownId?: string;
  @IsOptional() @IsUUID() itemId?: string;
  @IsOptional() @Matches(ISO) asOf?: string;
  /** Threshold — required (MAS holds no reorder attribute); a non-negative decimal string. */
  @IsOptional() @Matches(DECIMAL) reorderLevel?: string;
}

export class StockTransferReportQueryDto extends ReportPaging {
  @IsOptional() @IsIn(REPORT_FORMATS) format?: (typeof REPORT_FORMATS)[number];
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsUUID() godownId?: string;
  @IsOptional() @IsUUID() itemId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}

// ── Requisition & cost-control (FR-RPT-024) ────────────────────────────────────────────────────────
export class RequisitionVsIssueReportQueryDto extends ReportPaging {
  @IsOptional() @IsIn(REPORT_FORMATS) format?: (typeof REPORT_FORMATS)[number];
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @IsUUID() requisitionId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}

// ── HR reports (FR-RPT-026…028) ────────────────────────────────────────────────────────────────────
export class AttendanceSummaryReportQueryDto extends ReportPaging {
  @IsOptional() @IsIn(REPORT_FORMATS) format?: (typeof REPORT_FORMATS)[number];
  @Matches(MONTH) month!: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
}

export class SalaryRegisterReportQueryDto extends ReportPaging {
  @IsOptional() @IsIn(REPORT_FORMATS) format?: (typeof REPORT_FORMATS)[number];
  @IsOptional() @IsUUID() salaryRunId?: string;
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @Matches(MONTH) month?: string;
  @IsOptional() @IsUUID() projectId?: string;
}

export class EmployeePaymentReportQueryDto extends ReportPaging {
  @IsOptional() @IsIn(REPORT_FORMATS) format?: (typeof REPORT_FORMATS)[number];
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}

// ── Project reports (FR-RPT-015…020/-025) ────────────────────────────────────────────────────────────

export class ProjectPnlReportQueryDto extends ReportPaging {
  @IsUUID() financialYearId!: string;
  @IsOptional() @IsIn(REPORT_FORMATS) format?: (typeof REPORT_FORMATS)[number];
  /** Required — a project P&L is always for one project (PM must be assigned). */
  @IsUUID() projectId!: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}

export class IpcBillingReportQueryDto extends CommonReportQueryDto {
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}

export class OutstandingReportQueryDto extends CommonReportQueryDto {
  @IsOptional() @Matches(ISO) asOf?: string;
}

export class MaterialConsumptionReportQueryDto extends CommonReportQueryDto {
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}

export class LabourCostReportQueryDto extends CommonReportQueryDto {
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}

export class CostCentreVarianceReportQueryDto extends CommonReportQueryDto {
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
  /** csv of OK,APPROACHING,OVER,UNBUDGETED (validated in the service). */
  @IsOptional() @IsString() status?: string;
}
