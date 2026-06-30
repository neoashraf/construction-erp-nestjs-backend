/**
 * RealAuditService (AUD application) — records audit entries in the caller's UoW transaction.
 * Replaces NoopAuditService. Never opens its own transaction (FR-AUD-025).
 * Seal chain: H(prevSeal ‖ companyId ‖ action ‖ entityType ‖ entityId ‖ userId ‖ before ‖ after ‖ createdAt).
 * FR-AUD-020/021/022/023/024/025.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService, AuditEntry } from './audit.port';
import { AuditLog } from '../domain/audit-log.entity';
import { AuditLogRepository, AUDIT_LOG_REPOSITORY } from '../domain/ports/audit-log.repository.port';
import { computeSeal } from '../infrastructure/typeorm-audit-log.repository';

const SENSITIVE_FIELDS = ['passwordHash', 'password_hash', 'bankAccount', 'pfDetails'];

function sanitize(data: unknown): Record<string, unknown> | null {
  if (data == null) return null;
  const obj: Record<string, unknown> = typeof data === 'object' ? { ...(data as Record<string, unknown>) } : { value: data };
  for (const field of SENSITIVE_FIELDS) {
    if (field in obj) obj[field] = '[REDACTED]';
  }
  return obj as Record<string, unknown>;
}

@Injectable()
export class RealAuditService implements AuditService {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY) private readonly repo: AuditLogRepository,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const now = new Date();
    const prevSeal = await this.repo.lastSeal(entry.companyId);
    const before = sanitize(entry.before ?? null);
    const after = sanitize(entry.after ?? null);
    const seal = computeSeal(
      entry.companyId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.actorId,
      before,
      after,
      now.toISOString(),
      prevSeal,
    );
    const log = AuditLog.create(crypto.randomUUID(), {
      companyId: entry.companyId,
      action: entry.action as any,
      entityType: entry.entityType,
      entityId: entry.entityId,
      userId: entry.actorId,
      before,
      after,
      ipAddress: null,
      seal,
      createdAt: now,
    });
    await this.repo.append(log);
  }
}
