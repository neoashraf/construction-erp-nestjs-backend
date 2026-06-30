/**
 * AuditLog domain entity (AUD audit — FR-AUD-020..027). PURE TypeScript. Append-only.
 * No updated_at/deleted_at/version — immutable once written (FR-AUD-023).
 */
export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'POST' | 'CANCEL' | 'APPROVE' | 'REJECT' | 'ACTIVATE' | 'DEACTIVATE';

export interface AuditLogProps {
  companyId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  userId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  seal: string;
  createdAt: Date;
}

export class AuditLog {
  private constructor(
    readonly id: string,
    readonly props: Readonly<AuditLogProps>,
  ) {}

  static create(id: string, props: AuditLogProps): AuditLog {
    return new AuditLog(id, { ...props });
  }

  static rehydrate(id: string, props: AuditLogProps): AuditLog {
    return new AuditLog(id, { ...props });
  }
}
