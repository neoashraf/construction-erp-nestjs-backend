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
