/**
 * NumberingSeriesAdminRepository — domain PORT for the admin config surface (pure interface). The
 * allocator (`NumberingService`) is the only writer of `last_sequence`; this port covers ONLY the
 * forward-only prefix/padding config + the reference checks. Company-scoped (NFR-005).
 */
export interface NumberingSeriesRow {
  id: string;
  companyId: string;
  financialYearId: string;
  voucherType: string;
  prefix: string;
  paddingWidth: number;
  lastSequence: number;
  version: number;
}

export interface NewNumberingSeries {
  id: string;
  companyId: string;
  financialYearId: string;
  voucherType: string;
  prefix: string;
  paddingWidth: number;
}

export interface NumberingSeriesAdminRepository {
  /** Insert a pre-seeded series (lastSequence starts at 0). Throws SeriesAlreadyExistsError on dup. */
  create(series: NewNumberingSeries): Promise<void>;
  findById(id: string, companyId: string): Promise<NumberingSeriesRow | null>;
  /** Forward-only prefix/padding update, version-guarded; returns false if no row matched the version. */
  updateConfig(
    id: string,
    companyId: string,
    expectedVersion: number,
    patch: { prefix?: string; paddingWidth?: number },
  ): Promise<boolean>;
  /** True if a FinancialYear with this id exists AND belongs to the company (cross-company guard). */
  financialYearBelongsToCompany(financialYearId: string, companyId: string): Promise<boolean>;
}

export const NUMBERING_SERIES_ADMIN_REPOSITORY = Symbol('NumberingSeriesAdminRepository');
