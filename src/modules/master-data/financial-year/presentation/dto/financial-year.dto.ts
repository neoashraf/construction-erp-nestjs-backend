/**
 * FinancialYear request/query DTOs (PRESENTATION). Body JSON is snake_case (platform API convention);
 * pagination/filter QUERY params stay camelCase per overview §6 (`?page&pageSize&isActive`). The
 * domain validates `end_date > start_date` and the date format. `company_id` is never a body field.
 */
import { Transform } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateFinancialYearDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label!: string;

  @IsString()
  start_date!: string;

  @IsString()
  end_date!: string;
}

export class UpdateFinancialYearDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label?: string;

  @IsOptional()
  @IsString()
  start_date?: string;

  @IsOptional()
  @IsString()
  end_date?: string;

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
