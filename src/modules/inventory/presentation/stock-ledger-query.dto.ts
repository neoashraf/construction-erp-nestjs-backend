/**
 * Stock-ledger read query DTOs (PRESENTATION). camelCase; company implicit from JWT (never a param).
 * Dates are `YYYY-MM-DD` strings; ints parsed from the query string. Mirrors the ledger read DTOs.
 */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Min } from 'class-validator';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toNum = ({ value }: { value: unknown }) => (value === undefined ? undefined : Number(value));

class Paging {
  @IsOptional() @Transform(toNum) @IsInt() @Min(1) page?: number;
  @IsOptional() @Transform(toNum) @IsInt() @Min(1) pageSize?: number;
}

export class StockLedgerQueryDto extends Paging {
  @IsOptional() @IsUUID() godownId?: string;
  @IsOptional() @IsUUID() itemId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @Matches(ISO) asOfDate?: string;
}

export class StockMovementsQueryDto extends Paging {
  @IsUUID() godownId!: string;
  @IsUUID() itemId!: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
}
