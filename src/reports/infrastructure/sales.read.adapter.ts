/**
 * SalesReadAdapter (RPT · FR-RPT-016/-017/-020) — INFRASTRUCTURE `SalesReadPort`. Reads SAL's OWN per-IPC
 * billing / outstanding / retention via `@Inject(DATA_SOURCE)` + `getManager` (the sanctioned cross-module
 * read) running the SAME formulas SAL's `IpcQueryService` uses — SAL exports no query service, and this
 * brief forbids modifying SAL, so RPT runs the identical scoped SQL over `sales_invoice`, `retention_release`
 * (POSTED releases), and REC's `receipt_allocation` VIEW (posted, non-reversed IPC receipts). The numbers
 * therefore EQUAL SAL's for the same params (single source of truth, FR-RPT-004); a reversed receipt drops
 * out of the view so `outstandingAmount` rises again on the next run (SRS edge 12) — no stored state.
 *
 * Definitions (SAL FR-SAL-016/-019): outstanding = max(0, currentlyDue − Σ received); retentionHeld =
 * max(0, retention − Σ released); billed = currentlyDue + retention + advanceRecovered + VAT. Read-only:
 * only SELECT/aggregate; company is on every query (F3); the F4 project filter is applied server-side; money
 * is SAL's numeric(18,4) serialised as decimal strings (never float).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../database/database.module';
import { getManager } from '../../infrastructure/unit-of-work/transaction-context';
import {
  IpcBillingReadRow,
  IpcBillingTotals,
  SalesReadPort,
  SalesScope,
} from '../domain/ports/sales.read.port';

const POSTED = 'POSTED';

@Injectable()
export class SalesReadAdapter implements SalesReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private manager() {
    return getManager(this.dataSource);
  }

  async ipcBilling(scope: SalesScope): Promise<{ rows: IpcBillingReadRow[]; totals: IpcBillingTotals }> {
    // F4: [] → a valid empty report (no IPC rows), never all projects.
    if (scope.projectIds !== null && scope.projectIds.length === 0) {
      return { rows: [], totals: zeroTotals() };
    }

    const params: unknown[] = [scope.companyId, POSTED];
    const conds = ['i.company_id = $1', 'i.status = $2', 'i.deleted_at IS NULL'];
    const push = (sql: string, val: unknown) => {
      params.push(val);
      conds.push(sql.replace('$$', `$${params.length}`));
    };
    if (scope.financialYearId) push('i.financial_year_id = $$', scope.financialYearId);
    if (scope.dateFrom) push('i.ipc_date >= $$', scope.dateFrom);
    if (scope.dateTo) push('i.ipc_date <= $$', scope.dateTo);
    if (scope.projectIds !== null) {
      params.push(scope.projectIds);
      conds.push(`i.project_id = ANY($${params.length}::uuid[])`);
    }
    const where = conds.join(' AND ');

    // received (REC) and released (retention) are subqueries over the POSTED IPCs — the same joins SAL's
    // projectRegister uses (receipt_allocation view is already posted/non-reversed; retention_release POSTED).
    const rows: Array<{
      ipc_id: string;
      project_id: string;
      ipc_no: string | null;
      ipc_date: string;
      due_date: string;
      certified_amount: string;
      currently_due_amount: string;
      retention_amount: string;
      advance_recovered_amount: string;
      output_vat_amount: string;
      received_amount: string;
      released_amount: string;
    }> = await this.manager().query(
      `SELECT i.id AS ipc_id, i.project_id, i.entry_no AS ipc_no,
              to_char(i.ipc_date,'YYYY-MM-DD') AS ipc_date,
              to_char(i.due_date,'YYYY-MM-DD') AS due_date,
              i.certified_amount::text, i.currently_due_amount::text,
              i.retention_amount::text, i.advance_recovered_amount::text, i.output_vat_amount::text,
              COALESCE(rec.received_amount, 0)::text AS received_amount,
              COALESCE(rel.released_amount, 0)::text AS released_amount
         FROM sales_invoice i
         LEFT JOIN (
           SELECT ipc_id, SUM(amount_applied) AS received_amount
             FROM receipt_allocation GROUP BY ipc_id
         ) rec ON rec.ipc_id = i.id
         LEFT JOIN (
           SELECT ipc_id, SUM(released_amount) AS released_amount
             FROM retention_release WHERE company_id = $1 AND status = '${POSTED}' GROUP BY ipc_id
         ) rel ON rel.ipc_id = i.id
        WHERE ${where}
        ORDER BY i.project_id, i.ipc_seq_no`,
      params,
    );

    let cCertified = new Decimal(0);
    let cBilled = new Decimal(0);
    let cReceived = new Decimal(0);
    let cOutstanding = new Decimal(0);
    let cRetention = new Decimal(0);

    const mapped: IpcBillingReadRow[] = rows.map((r) => {
      const certified = new Decimal(r.certified_amount);
      const currentlyDue = new Decimal(r.currently_due_amount);
      const retention = new Decimal(r.retention_amount);
      const advanceRecovered = new Decimal(r.advance_recovered_amount);
      const vat = new Decimal(r.output_vat_amount);
      const received = new Decimal(r.received_amount);
      const released = new Decimal(r.released_amount);
      // SAL's definitions (FR-SAL-016/-019) — negative clamps to 0, exactly as IpcQueryService.
      const billed = currentlyDue.plus(retention).plus(advanceRecovered).plus(vat);
      const outstandingRaw = currentlyDue.minus(received);
      const outstanding = outstandingRaw.isNegative() ? new Decimal(0) : outstandingRaw;
      const heldRaw = retention.minus(released);
      const retentionHeld = heldRaw.isNegative() ? new Decimal(0) : heldRaw;

      cCertified = cCertified.plus(certified);
      cBilled = cBilled.plus(billed);
      cReceived = cReceived.plus(received);
      cOutstanding = cOutstanding.plus(outstanding);
      cRetention = cRetention.plus(retentionHeld);

      return {
        ipcId: r.ipc_id,
        projectId: r.project_id,
        ipcNo: r.ipc_no,
        ipcDate: r.ipc_date,
        dueDate: r.due_date,
        certifiedAmount: certified.toFixed(4),
        billedAmount: billed.toFixed(4),
        receivedAmount: received.toFixed(4),
        outstandingAmount: outstanding.toFixed(4),
        retentionHeld: retentionHeld.toFixed(4),
      };
    });

    return {
      rows: mapped,
      totals: {
        certified: cCertified.toFixed(4),
        billed: cBilled.toFixed(4),
        received: cReceived.toFixed(4),
        outstanding: cOutstanding.toFixed(4),
        retentionHeld: cRetention.toFixed(4),
      },
    };
  }
}

function zeroTotals(): IpcBillingTotals {
  return { certified: '0.0000', billed: '0.0000', received: '0.0000', outstanding: '0.0000', retentionHeld: '0.0000' };
}
