/**
 * Dashboard query DTO (DSH · PRESENTATION · FR-DSH-005/§11) — class-validator, camelCase. Company is
 * implicit from the JWT (never a param). A project-scoped caller passing an unassigned `projectId` is 403
 * (enforced downstream in ReportScopeService). `dateFrom ≤ dateTo` is asserted in the controller.
 */
import { IsOptional, IsUUID, Matches } from 'class-validator';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

export class DashboardQueryDto {
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @Matches(ISO) dateFrom?: string;
  @IsOptional() @Matches(ISO) dateTo?: string;
  @IsOptional() @Matches(MONTH) month?: string;
  @IsOptional() @IsUUID() godownId?: string;
  /** Low-stock re-order threshold (RPT report param; MAS holds no reorder attribute — SRS edge 9). */
  @IsOptional() @Matches(DECIMAL) reorderLevel?: string;
}
