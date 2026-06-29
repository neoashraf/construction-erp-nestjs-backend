/**
 * Numbering-series request/query DTOs (PRESENTATION). camelCase wire JSON (overview §6). `lastSequence`
 * is NOT a field anywhere — the global ValidationPipe (forbidNonWhitelisted) rejects an attempt to set
 * it (FR-NUM-018). The domain helpers do prefix/padding validation; `companyId` comes from the actor.
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateNumberingSeriesDto {
  @IsUUID()
  financialYearId!: string;

  @IsString()
  voucherType!: string;

  @IsOptional()
  @IsString()
  prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  paddingWidth?: number;
}

export class UpdateNumberingSeriesDto {
  @IsOptional()
  @IsString()
  prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  paddingWidth?: number;

  @IsInt()
  @Min(1)
  version!: number;
}

export class ListNumberingSeriesQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsUUID()
  financialYearId?: string;

  @IsOptional()
  @IsString()
  voucherType?: string;
}
