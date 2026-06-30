/** Shared MAS presentation DTOs. camelCase wire JSON (overview §6). */
import { Transform } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsString, Min } from 'class-validator';

/** Body for deactivate/reactivate/status no-op transitions that only need the optimistic version. */
export class VersionBodyDto {
  @IsInt()
  @Min(1)
  version!: number;
}

/** Standard list query (page/pageSize + active filter + typeahead q). */
export class MasterListQueryDto {
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
  @IsBooleanString()
  isActive?: string;

  @IsOptional()
  @IsString()
  q?: string;
}

export const parseActive = (v?: string): boolean | undefined =>
  v === undefined ? undefined : v === 'true';
