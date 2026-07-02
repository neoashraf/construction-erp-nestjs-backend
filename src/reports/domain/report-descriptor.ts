/**
 * ReportDescriptor + catalog types (RPT · FR-RPT-001/-002/-004/-008/-029) — PURE domain (no Nest, no
 * TypeORM). A descriptor is one catalog entry: the report's `name` (the `/api/reports/<name>` path
 * segment), the owning read `source` it queries (LED/INV/HR/… — never two definitions of one figure,
 * FR-RPT-004), its accepted `parameters`, the AUD `requiredPermission` gating it (FR-RPT-008), whether
 * it is filtered to a project-scoped user's assigned projects (FR-RPT-006), and whether it is a balance
 * (as-of/period) or flow (date-range) report. Later RPT briefs (#31/#32/#33) append INVENTORY/HR/PROJECT
 * descriptors to the catalog; this brief lands the six LED financial reports.
 */
import { ActionCode, ModuleCode } from '../../core/auth/domain/permission.entity';

export type ReportSource =
  | 'LEDGER'
  | 'COST_CONTROL'
  | 'SALES_IPC'
  | 'INVENTORY'
  | 'HR'
  | 'PROJECT'
  | 'REQUISITION';

export type ReportFormat = 'json' | 'excel' | 'pdf';

/** The AUD permission gating a report (FR-RPT-008). RPT's financial reports map to `RPT:READ`. */
export interface ReportPermission {
  module: ModuleCode;
  action: ActionCode;
}

export interface ReportDescriptor {
  /** Catalog name / path segment, e.g. 'trial-balance'. Unique across the catalog. */
  name: string;
  /** Human-readable title for the report runner / export filename. */
  title: string;
  /** The owning read source the report queries (FR-RPT-004). */
  source: ReportSource;
  /** The FR the report satisfies (e.g. 'FR-RPT-009'). */
  fr: string;
  /** Accepted parameter names (FR-RPT-002) — always includes `financialYearId`. */
  parameters: string[];
  /** Always all three formats (FR-RPT-029); the JSON exporter ships in this brief, xlsx/pdf in #30. */
  formats: ReportFormat[];
  /** The AUD permission gating the report (FR-RPT-008). */
  requiredPermission: ReportPermission;
  /** Filtered to assigned projects for project-scoped users (FR-RPT-006). */
  projectScoped: boolean;
  /** Balance report (as-of/period precedence) vs flow report (date range) — SRS §4 As-of vs range. */
  asOf: boolean;
}
