/**
 * FinancialYear request/query DTOs (PRESENTATION). Wire JSON is camelCase per the platform API
 * convention (overview §6). The domain validates `endDate > startDate` and the date format.
 * `companyId` is never a body field — it comes from the actor (FR-MAS-001).
 */
import { Transform } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateFinancialYearDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label!: string;

  @IsString()
  startDate!: string;

  @IsString()
  endDate!: string;
}

export class UpdateFinancialYearDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class ListFinancialYearsQueryDto {
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

  /** `?isActive=true|false` (string in the query; resolved in the controller). */
  @IsOptional()
  @IsBooleanString()
  isActive?: string;
}
