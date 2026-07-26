/**
 * Query DTOs for the attendance reports. Deliberately typed as plain optional strings rather than
 * `@IsDateString()` / `@IsInt()`: the date rules live in `assertDateText()` so the API returns the
 * guide's exact messages ("date must be in YYYY-MM-DD format", "date is not a valid calendar date" for
 * `2026-02-31`) instead of class-validator's wording, and so a bad `page` degrades to the default the
 * way the source project does rather than 400-ing. The DTOs exist only to satisfy the global
 * `ValidationPipe({ whitelist, forbidNonWhitelisted })` — they declare which parameters are allowed.
 *
 * `page` / `limit` are accepted on the export routes too and then ignored: exports always run with
 * `includeAll` (§3.6), so a UI that reuses its list query-string for the download link still works.
 */
import { IsOptional, IsString } from 'class-validator';

export class DailyReportQueryDto {
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() name?: string;
}

export class RangeReportQueryDto {
  @IsOptional() @IsString() dateFrom?: string;
  @IsOptional() @IsString() dateTo?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() name?: string;
}
