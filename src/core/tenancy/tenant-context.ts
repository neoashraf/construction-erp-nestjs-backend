/**
 * Tenancy primitives (ADR-0002 F3, skill §10, NFR-005) — PURE TypeScript (no NestJS/TypeORM).
 *
 * Every use case and read service is handed an `Actor`: who is acting, in which company + financial
 * year, with what role and project scope. Repositories take `companyId` (and `financialYearId` for
 * year-bound data) as NON-optional inputs and scope every query — a query without `companyId` is a
 * P1 cross-tenant leak. The scoped-repository base makes that filter the default, not a thing you
 * remember.
 */
import Decimal from 'decimal.js';

/** The authenticated caller and their tenant scope. RBAC fields enriched by JwtStrategy (auth-rbac). */
export interface Actor {
  readonly userId: string;
  readonly companyId: string;
  readonly financialYearId: string;
  /** Single role per user (AUD Phase-1 rule). */
  readonly role: string;
  /** True for unscoped roles (Admin, Accounts Team) — bypass project filter. FR-AUD-015. */
  readonly isUnscoped: boolean;
  /** Project ids this actor may see. Empty for scoped users with zero assignments. FR-AUD-014. */
  readonly assignedProjectIds: readonly string[];
  /** Max approvable value BDT. null = no approval authority (escalate-by-default). FR-AUD-016. */
  readonly approvalLimit: Decimal | null;
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
