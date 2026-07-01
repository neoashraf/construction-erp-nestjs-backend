/**
 * Cost-control read/advisory DTOs (PRESENTATION). camelCase; company implicit from JWT (never a
 * param). Dates are `YYYY-MM-DD` strings; money is a Decimal(18,4) string. Ints are coerced from the
 * query string via @Transform. Body money for the prospective check is validated as a numeric string.
 */
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// Non-negative Decimal(18,4) — a prospective cost amount is ≥ 0 (contract: negative → 400).
const MONEY = /^\d+(\.\d{1,4})?$/;
const toNum = ({ value }: { value: unknown }) => (value === undefined ? undefined : Number(value));

class Paging {
  @IsOptional() @Transform(toNum) @IsInt() @Min(1) page?: number;
  @IsOptional() @Transform(toNum) @IsInt() @Min(1) pageSize?: number;
}

export class BudgetVsActualQueryDto extends Paging {
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
  /** csv of OK,APPROACHING,OVER,UNBUDGETED. */
  @IsOptional() @IsString() status?: string;
}

export class ProfitabilityQueryDto extends Paging {
  @IsOptional() @IsString() groupBy?: string;
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}

export class AlertsQueryDto extends Paging {
  /** subset of OVER,APPROACHING. */
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() projectId?: string;
}

export class BudgetCheckLineDto {
  @IsUUID() projectId!: string;
  @IsUUID() costCentreId!: string;
  @Matches(MONEY, { message: 'amount must be a non-negative Decimal(18,4) string' }) amount!: string;
}

export class BudgetCheckBodyDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BudgetCheckLineDto)
  lines!: BudgetCheckLineDto[];
}
