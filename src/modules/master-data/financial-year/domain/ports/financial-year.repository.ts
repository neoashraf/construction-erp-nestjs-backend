/**
 * FinancialYearRepository — domain port (PURE). Company-scoped: every method takes `companyId`
 * (from the actor) and the adapter injects it into every query (NFR-005). The application depends
 * on this interface; the TypeORM adapter lives in infrastructure.
 */
import { FinancialYear } from '../financial-year';

export interface FinancialYearRepository {
  /** Persist a new or updated financial year (optimistic concurrency via row `version`). */
  save(fy: FinancialYear, companyId: string): Promise<void>;

  /** Load one financial year by id within the company. */
  findById(id: string, companyId: string): Promise<FinancialYear | null>;

  /** The currently-active financial year for the company, if any (used by set-active). */
  findActive(companyId: string): Promise<FinancialYear | null>;
}

/** DI token for the FinancialYearRepository port. */
export const FINANCIAL_YEAR_REPOSITORY = Symbol('FinancialYearRepository');
