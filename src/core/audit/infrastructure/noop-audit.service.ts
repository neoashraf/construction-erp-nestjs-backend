/**
 * NoopAuditService — temporary stand-in for the AUD AuditService (INFRASTRUCTURE). The real audit_log
 * persistence lands in `rbac-and-audit`; until then this satisfies the port so callers can record
 * unconditionally. Debug-logs the intent (no PII) and persists nothing. REBIND `AUDIT_SERVICE` to the
 * real service in AuditModule when AUD lands.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AuditEntry, AuditService } from '../application/audit.port';

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
