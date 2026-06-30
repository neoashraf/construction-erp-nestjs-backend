import { AuditLog, AuditAction } from '../audit-log.entity';

export interface AuditQuery {
  companyId: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  action?: AuditAction;
  projectId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  pageSize: number;
}

export interface AuditLogRepository {
  append(log: AuditLog): Promise<void>;
  lastSeal(companyId: string): Promise<string | null>;
  findById(id: string, companyId: string): Promise<AuditLog | null>;
  query(filter: AuditQuery): Promise<{ items: AuditLog[]; total: number }>;
  queryForExport(filter: Omit<AuditQuery, 'page' | 'pageSize'>): Promise<AuditLog[]>;
  verifyChain(companyId: string, from?: Date, to?: Date): Promise<{ ok: boolean; brokenAt?: string }>;
}

export const AUDIT_LOG_REPOSITORY = Symbol('AuditLogRepository');
