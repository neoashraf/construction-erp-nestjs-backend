/**
 * Audit kernel module (AUD). Provides the canonical `AUDIT_SERVICE` port GLOBALLY so any module can
 * record audit entries without importing a module. The `rbac-and-audit` brief replaces the
 * `NoopAuditService` binding with the real `audit_log`-backed service (same token, same call shape).
 */
import { Global, Module } from '@nestjs/common';
import { AUDIT_SERVICE } from './application/audit.port';
import { NoopAuditService } from './infrastructure/noop-audit.service';

@Global()
@Module({
  providers: [{ provide: AUDIT_SERVICE, useClass: NoopAuditService }],
  exports: [AUDIT_SERVICE],
})
export class AuditModule {}
