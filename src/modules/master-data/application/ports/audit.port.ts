/**
 * AuditService — typed SEAM for FR-MAS-031 (audit every master create/update/deactivate with actor,
 * timestamp, before/after). The real implementation + `audit_log` table are owned by AUD and land in
 * the `rbac-and-audit` brief; until then the MAS module binds the `NoopAuditService` stand-in to this
 * token. When AUD ships, rebind `AUDIT_SERVICE` → AUD's `AuditService` (same call shape) — no use-case
 * change required. Use cases call `audit.record(...)` INSIDE their `uow.run` so the audit row commits
 * atomically with the mutation (skill §8).
 */

export type AuditAction = 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'ACTIVATE';

export interface AuditEntry {
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorId: string;
  readonly companyId: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface AuditService {
  record(entry: AuditEntry): Promise<void>;
}

/** DI token for the AuditService port. */
export const AUDIT_SERVICE = Symbol('AuditService');
