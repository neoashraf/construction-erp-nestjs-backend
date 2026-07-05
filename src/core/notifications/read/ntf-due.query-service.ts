/**
 * NtfDueQueryService (NTF read/ — FR-NTF-022..025). Raw-SQL scans of due-date state that the scheduler
 * turns into reminder notifications. Read-only + company-scoped per row; posts nothing, changes nothing.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';

export interface PeriodClosingRow {
  id: string;
  companyId: string;
  name: string;
  endDate: string; // YYYY-MM-DD
}
export interface OverdueIpcRow {
  id: string;
  companyId: string;
  projectId: string;
  ipcSeqNo: number | null;
  dueDate: string; // YYYY-MM-DD
}

@Injectable()
export class NtfDueQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  /** OPEN accounting periods whose end_date falls within [today, today+windowDays]. */
  async periodsClosingSoon(today: string, windowDays: number): Promise<PeriodClosingRow[]> {
    const rows = await this.ds.query(
      `SELECT id, company_id AS "companyId", name, end_date AS "endDate"
       FROM accounting_period
       WHERE status = 'OPEN' AND end_date >= $1::date AND end_date <= ($1::date + ($2 || ' days')::interval)
       ORDER BY end_date`,
      [today, windowDays],
    );
    return rows.map((r: any) => ({ id: r.id, companyId: r.companyId, name: r.name, endDate: fmt(r.endDate) }));
  }

  /** POSTED IPCs whose due_date is strictly before today. */
  async overdueIpcs(today: string): Promise<OverdueIpcRow[]> {
    const rows = await this.ds.query(
      `SELECT id, company_id AS "companyId", project_id AS "projectId", ipc_seq_no AS "ipcSeqNo", due_date AS "dueDate"
       FROM sales_invoice
       WHERE status = 'POSTED' AND due_date < $1::date
       ORDER BY due_date`,
      [today],
    );
    return rows.map((r: any) => ({
      id: r.id, companyId: r.companyId, projectId: r.projectId, ipcSeqNo: r.ipcSeqNo ?? null, dueDate: fmt(r.dueDate),
    }));
  }
}

/** pg returns `date` as a Date (local midnight) or string; normalise to YYYY-MM-DD. */
function fmt(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
