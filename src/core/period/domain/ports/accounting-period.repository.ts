/**
 * AccountingPeriodRepository — domain PORT (pure). Company-scoped (NFR-005). `findOwningForUpdate`
 * resolves a date → its owning period under a row lock so a concurrent close serialises against an
 * in-flight post (FR-PER-005, technical design §5.4).
 */
import { AccountingPeriod } from '../accounting-period';

export interface AccountingPeriodRepository {
  /** date → owning period, locked FOR UPDATE (the post-time guard's hot path). */
  findOwningForUpdate(
    companyId: string,
    financialYearId: string,
    date: string,
  ): Promise<AccountingPeriod | null>;
  findById(id: string, companyId: string): Promise<AccountingPeriod | null>;
  listByFy(companyId: string, financialYearId: string): Promise<AccountingPeriod[]>;
  existsAnyForFy(companyId: string, financialYearId: string): Promise<boolean>;
  save(period: AccountingPeriod): Promise<void>;
  saveMany(periods: AccountingPeriod[]): Promise<void>;
  /** True if a financial year with this id exists for the company (MAS reference check). */
  financialYearExists(companyId: string, financialYearId: string): Promise<boolean>;
  /** The FY's `[start_date, end_date]` bounds (for generation), or null if not found. */
  financialYearBounds(
    companyId: string,
    financialYearId: string,
  ): Promise<{ startDate: string; endDate: string } | null>;
}

export const ACCOUNTING_PERIOD_REPOSITORY = Symbol('AccountingPeriodRepository');
