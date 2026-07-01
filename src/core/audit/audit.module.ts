/**
 * AuditModule (AUD rbac-and-audit brief) — replaces NoopAuditService with the real DB-backed
 * implementation. Provides AUDIT_SERVICE globally; exports AUDIT_SERVICE + AUDIT_LOG_REPOSITORY.
 */
import { Global, Module } from '@nestjs/common';
import { AUDIT_SERVICE } from './application/audit.port';
import { RealAuditService } from './application/real-audit.service';
import { TypeOrmAuditLogRepository } from './infrastructure/typeorm-audit-log.repository';
import { AUDIT_LOG_REPOSITORY } from './domain/ports/audit-log.repository.port';
import { AuditLogsController } from './presentation/audit-logs.controller';
import { AuditLogsQueryService } from './read/audit-logs.query-service';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  // AuthModule is imported so AuditLogsController can resolve JwtAuthGuard + RolesGuard
  // (the guard injects ROLE_REPOSITORY + PERMISSION_REPOSITORY, exported by AuthModule).
  // AuthModule consumes AUDIT_SERVICE via the @Global registration — not an explicit
  // import of AuditModule — so there is no module import cycle.
  imports: [AuthModule],
  controllers: [AuditLogsController],
  providers: [
    { provide: AUDIT_LOG_REPOSITORY, useClass: TypeOrmAuditLogRepository },
    { provide: AUDIT_SERVICE, useClass: RealAuditService },
    AuditLogsQueryService,
  ],
  exports: [AUDIT_SERVICE, AUDIT_LOG_REPOSITORY],
})
export class AuditModule {}
