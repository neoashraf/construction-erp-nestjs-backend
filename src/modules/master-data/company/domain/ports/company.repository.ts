/**
 * CompanyRepository — domain port (PURE). The application depends on this interface; the TypeORM
 * adapter lives in infrastructure. Company is the tenant root: reads/edits are scoped by the
 * company's own `id` (the actor's company), never by a separate `company_id` column.
 */
import { Company } from '../company';

export interface CompanyRepository {
  /** Persist a new or updated company. Enforces optimistic concurrency via the row `version`. */
  save(company: Company): Promise<void>;

  /** Load a single company by id (the actor's own company in Phase-1 single-company). */
  findById(id: string): Promise<Company | null>;
}

/** DI token for the CompanyRepository port. */
export const COMPANY_REPOSITORY = Symbol('CompanyRepository');
