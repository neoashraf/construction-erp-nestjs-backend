/**
 * AuditService — the canonical audit PORT (core/audit, owned by AUD). Every create/update/post/cancel
 * records who/when/before/after for tamper-evidence (NFR-003). The real implementation + `audit_log`
 * table land in the `rbac-and-audit` brief; until then `AUDIT_SERVICE` is bound to `NoopAuditService`
 * (see audit.module.ts). Callers invoke `record(...)` INSIDE their `uow.run` so the audit row commits
 * atomically with the mutation.
 */
export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DEACTIVATE'
  | 'REACTIVATE'
  | 'ACTIVATE'
  | 'POST'
  | 'CANCEL';

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

/** DI token for the canonical AuditService port (provided globally by AuditModule). */
export const AUDIT_SERVICE = Symbol('AuditService');
