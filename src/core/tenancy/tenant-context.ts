/**
 * Tenancy primitives (ADR-0002 F3, skill §10, NFR-005) — PURE TypeScript (no NestJS/TypeORM).
 *
 * Every use case and read service is handed an `Actor`: who is acting, in which company + financial
 * year, with what role and project scope. Repositories take `companyId` (and `financialYearId` for
 * year-bound data) as NON-optional inputs and scope every query — a query without `companyId` is a
 * P1 cross-tenant leak. The scoped-repository base makes that filter the default, not a thing you
 * remember.
 */

/** The authenticated caller and their tenant scope. Role/permissions are filled in by the AUD brief. */
export interface Actor {
  readonly userId: string;
  readonly companyId: string;
  readonly financialYearId: string;
  /** Single role per user (AUD Phase-1 rule); typed precisely once roles land. */
  readonly role: string;
  /**
   * Row-level project scope (F4): the project ids this actor may see. `undefined` = all projects
   * (e.g. Accounts/Admin); a list = restricted (e.g. a PM sees only assigned projects).
   */
  readonly projectScope?: readonly string[];
}

/** The minimal tenant scope a repository needs to be safe. */
export interface TenantContext {
  readonly companyId: string;
  /** Present for year-bound data (vouchers, journal entries, salary sheets); omitted otherwise. */
  readonly financialYearId?: string;
}

/** Narrow an `Actor` to the company-only tenant scope. */
export function companyScope(actor: Actor): TenantContext {
  return { companyId: actor.companyId };
}

/** Narrow an `Actor` to the company + financial-year scope (for year-bound data). */
export function fiscalScope(actor: Actor): TenantContext {
  return { companyId: actor.companyId, financialYearId: actor.financialYearId };
}
