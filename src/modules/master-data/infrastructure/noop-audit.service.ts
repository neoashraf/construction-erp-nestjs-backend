/**
 * NoopAuditService — temporary stand-in for the AUD `AuditService` (FR-MAS-031). INFRASTRUCTURE.
 * AUD's audit_log table is not built until the `rbac-and-audit` brief; until then this satisfies the
 * port so MAS use cases can call `audit.record(...)` unconditionally. It debug-logs the intent (no
 * PII) and persists nothing. REMOVE/REBIND when AUD lands: bind `AUDIT_SERVICE` to AUD's service in
 * `master-data.module.ts`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AuditEntry, AuditService } from '../application/ports/audit.port';

@Injectable()
export class NoopAuditService implements AuditService {
  private readonly logger = new Logger('AuditService(seam)');

  record(entry: AuditEntry): Promise<void> {
    this.logger.debug(
      `[audit-seam] ${entry.action} ${entry.entityType}#${entry.entityId} by ${entry.actorId} (company ${entry.companyId})`,
    );
    return Promise.resolve();
  }
}
