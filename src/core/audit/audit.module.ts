/**
 * Audit kernel module (AUD) — EMPTY-BUT-WIRED.
 *
 * `AuditService` + the `audit_log` table (jsonb before/after on every mutation + post/cancel,
 * NFR-003) land here in the `rbac-and-audit` brief. No business logic ships in the scaffold.
 */
import { Module } from '@nestjs/common';

@Module({})
export class AuditModule {}
