/**
 * TagConsistencyService (CC domain port) — enforces FR-CC-004: a voucher line's project-scoped tags
 * (`purpose` / `godown`) must belong to the line's own `project`. Complements LED's TagMatrix (which
 * only checks same-company + active). Voucher modules call `assertConsistent` in their draft-save
 * validation; a mismatch surfaces as `400 CROSS_PROJECT_DIMENSION` on the voucher endpoint (not a CC
 * endpoint). CC owns the rule; the voucher endpoints carry the error.
 */

/** Company context (company from JWT, never the body). */
export interface CompanyContext {
  companyId: string;
}

/** A voucher line's project + its optional project-scoped dimension tags. */
export interface TagLine {
  projectId: string;
  purposeId?: string | null;
  godownId?: string | null;
}

export interface TagConsistencyService {
  /** Throws `CrossProjectDimensionError` if any line's purpose/godown belongs to another project. */
  assertConsistent(ctx: CompanyContext, lines: TagLine[]): Promise<void>;
}

export const TAG_CONSISTENCY_SERVICE = Symbol('TAG_CONSISTENCY_SERVICE');
