/**
 * Period request/query DTOs (PRESENTATION). camelCase wire JSON (overview §6). `companyId` is implicit
 * from the JWT, never a body/query field (NFR-005). Dates are `YYYY-MM-DD`.
 */
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Min } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class GeneratePeriodsDto {
  @IsUUID()
  financialYearId!: string;
}

export class CloseFyDto {
  @IsUUID()
  financialYearId!: string;
}

export class ListPeriodsQueryDto {
  @IsUUID()
  financialYearId!: string;

  @IsOptional()
  @IsIn(['OPEN', 'CLOSED'])
  status?: 'OPEN' | 'CLOSED';

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
}

export class ResolvePeriodQueryDto {
  @IsUUID()
  financialYearId!: string;

  @IsString()
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;
}
