/**
 * Ledger read query DTOs (PRESENTATION). camelCase, company implicit from JWT (never a param).
 * Money/dates are strings; booleans/ints parsed from the query string via @Transform.
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Min } from 'class-validator';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toBool = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;
const toNum = ({ value }: { value: unknown }) => (value === undefined ? undefined : Number(value));

class Paging {
  @IsOptional()
  @Transform(toNum)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(toNum)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class EntriesQueryDto extends Paging {
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsUUID() periodId?: string;
  @IsOptional() @IsString() voucherType?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
  @IsOptional() @IsString() sourceType?: string;
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @IsString() entryNo?: string;
  @IsOptional() @Transform(toBool) @IsBoolean() isReversal?: boolean;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @IsUUID() purposeId?: string;
  @IsOptional() @IsUUID() godownId?: string;
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsUUID() partyId?: string;
}

export class LinesQueryDto extends EntriesQueryDto {}

export class TrialBalanceQueryDto extends Paging {
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsUUID() periodId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
  @IsOptional() @IsString() groupBy?: string;
  @IsOptional() @Transform(toBool) @IsBoolean() includeReversals?: boolean;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
}
