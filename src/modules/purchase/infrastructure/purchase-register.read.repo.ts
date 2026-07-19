/**
 * PurchaseRegisterReadRepo (INFRASTRUCTURE, read) — the raw-SQL aggregations behind the PO→Bill→GRN
 * three-way match and the supplier/project purchase registers (FR-PUR-017, FR-PUR-018, FR-PUR-020,
 * FR-PUR-021). Everything here is a QUERY over the voucher records (purchase_order/_line,
 * purchase_bill/_line, grn/grn_line) and the ledger (journal_line by party_id + the AP control account,
 * code 2100) — NEVER a stored running balance (design §5.5). Only POSTED bills/GRNs count; a cancelled
 * voucher drops out on the next read with nothing to unwind.
 *
 * billed-vs-received linking: a bill line does not carry a po_line_id (SRS §8), so billed quantities roll
 * up to a PO line by ITEM within the PO's posted bills — the same stable item-matching #25's bill post
 * uses for applyBilledQty. Received quantities roll up by item across POSTED GRNs referencing the PO
 * directly OR referencing one of the PO's bills.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { WELL_KNOWN_PURCHASE_ACCOUNTS } from './well-known-purchase-accounts';

export interface PoMatchRow {
  lineNo: number;
  itemId: string;
  orderedQty: string;
  billedQty: string;
  receivedQty: string;
  /** A representative POSTED bill covering this line's item (most recent), for drill-down. */
  billId: string | null;
  billRef: string | null;
  /** A representative POSTED GRN covering this line's item (most recent), for drill-down. */
  grnId: string | null;
  grnRef: string | null;
}

export interface RegisterBillRow {
  billId: string;
  entryNo: string | null;
  billDate: string;
  projectId: string;
  supplierId: string;
  grossAmount: string;
  vatInputAmount: string;
  tdsAmount: string;
  aitAmount: string;
  netPayableAmount: string;
}

export interface RegisterFilter {
  companyId: string;
  supplierId?: string;
  projectId?: string;
  financialYearId?: string;
  /** PM row-level scope (F4) — when set, only bills of these projects are visible. */
  assignedProjectIds?: readonly string[] | null;
}

@Injectable()
export class PurchaseRegisterReadRepo {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  /** Ordered vs billed (POSTED bills of the PO, by item) vs received (POSTED GRNs of the PO/its bills). */
  async poMatchRows(poId: string, companyId: string): Promise<PoMatchRow[]> {
    const m = getManager(this.dataSource);
    const rows = (await m.query(
      `SELECT pol.line_no                                   AS "lineNo",
              pol.item_id                                   AS "itemId",
              pol.ordered_qty::text                         AS "orderedQty",
              COALESCE(b.billed, 0)::text                   AS "billedQty",
              COALESCE(r.received, 0)::text                 AS "receivedQty",
              bref.bill_id                                  AS "billId",
              bref.entry_no                                 AS "billRef",
              gref.grn_id                                   AS "grnId",
              gref.grn_ref_no                               AS "grnRef"
         FROM purchase_order_line pol
         JOIN purchase_order po ON po.id = pol.purchase_order_id
         LEFT JOIN LATERAL (
           SELECT SUM(pbl.billed_qty) AS billed
             FROM purchase_bill_line pbl
             JOIN purchase_bill pb ON pb.id = pbl.purchase_bill_id
            WHERE pb.purchase_order_id = po.id
              AND pb.company_id = po.company_id
              AND pb.status = 'POSTED'
              AND pbl.item_id = pol.item_id
         ) b ON TRUE
         LEFT JOIN LATERAL (
           SELECT SUM(gl.received_qty) AS received
             FROM grn_line gl
             JOIN grn g ON g.id = gl.grn_id
            WHERE g.company_id = po.company_id
              AND g.status = 'POSTED'
              AND gl.item_id = pol.item_id
              AND (g.purchase_order_id = po.id
                   OR g.purchase_bill_id IN (
                        SELECT id FROM purchase_bill
                         WHERE purchase_order_id = po.id AND company_id = po.company_id))
         ) r ON TRUE
         LEFT JOIN LATERAL (
           SELECT pb.id AS bill_id, pb.entry_no
             FROM purchase_bill_line pbl
             JOIN purchase_bill pb ON pb.id = pbl.purchase_bill_id
            WHERE pb.purchase_order_id = po.id
              AND pb.company_id = po.company_id
              AND pb.status = 'POSTED'
              AND pbl.item_id = pol.item_id
            ORDER BY pb.bill_date DESC, pb.created_at DESC
            LIMIT 1
         ) bref ON TRUE
         LEFT JOIN LATERAL (
           SELECT g.id AS grn_id, g.grn_ref_no
             FROM grn_line gl
             JOIN grn g ON g.id = gl.grn_id
            WHERE g.company_id = po.company_id
              AND g.status = 'POSTED'
              AND gl.item_id = pol.item_id
              AND (g.purchase_order_id = po.id
                   OR g.purchase_bill_id IN (
                        SELECT id FROM purchase_bill
                         WHERE purchase_order_id = po.id AND company_id = po.company_id))
            ORDER BY g.receipt_date DESC, g.created_at DESC
            LIMIT 1
         ) gref ON TRUE
        WHERE pol.purchase_order_id = $1 AND po.company_id = $2
        ORDER BY pol.line_no`,
      [poId, companyId],
    )) as PoMatchRow[];
    return rows;
  }

  /** POSTED bill rows for the supplier/project register (FR-PUR-021) — voucher records, never balances. */
  async registerRows(filter: RegisterFilter): Promise<RegisterBillRow[]> {
    const m = getManager(this.dataSource);
    const params: unknown[] = [filter.companyId];
    const where: string[] = [`pb.company_id = $1`, `pb.status = 'POSTED'`, `pb.deleted_at IS NULL`];
    if (filter.supplierId) {
      params.push(filter.supplierId);
      where.push(`pb.supplier_id = $${params.length}`);
    }
    if (filter.projectId) {
      params.push(filter.projectId);
      where.push(`pb.project_id = $${params.length}`);
    }
    if (filter.financialYearId) {
      params.push(filter.financialYearId);
      where.push(`pb.financial_year_id = $${params.length}`);
    }
    if (filter.assignedProjectIds) {
      if (!filter.assignedProjectIds.length) return [];
      params.push(filter.assignedProjectIds);
      where.push(`pb.project_id = ANY($${params.length}::uuid[])`);
    }
    return (await m.query(
      `SELECT pb.id                        AS "billId",
              pb.entry_no                  AS "entryNo",
              pb.bill_date::text           AS "billDate",
              pb.project_id                AS "projectId",
              pb.supplier_id               AS "supplierId",
              pb.gross_amount::text        AS "grossAmount",
              pb.vat_input_amount::text    AS "vatInputAmount",
              pb.tds_amount::text          AS "tdsAmount",
              pb.ait_amount::text          AS "aitAmount",
              pb.net_payable_amount::text  AS "netPayableAmount"
         FROM purchase_bill pb
        WHERE ${where.join(' AND ')}
        ORDER BY pb.bill_date, pb.created_at`,
      params,
    )) as RegisterBillRow[];
  }

  /** Σ received_qty per purchase_bill_line across POSTED GRNs, for a bill's derived line fields. */
  async receivedPerBillLine(billId: string, companyId: string): Promise<Map<string, Decimal>> {
    const m = getManager(this.dataSource);
    const rows = (await m.query(
      `SELECT gl.purchase_bill_line_id AS "billLineId", SUM(gl.received_qty)::text AS total
         FROM grn_line gl
         JOIN grn g ON g.id = gl.grn_id
         JOIN purchase_bill_line pbl ON pbl.id = gl.purchase_bill_line_id
        WHERE pbl.purchase_bill_id = $1 AND g.company_id = $2 AND g.status = 'POSTED'
        GROUP BY gl.purchase_bill_line_id`,
      [billId, companyId],
    )) as { billLineId: string; total: string }[];
    return new Map(rows.map((r) => [r.billLineId, new Decimal(r.total)]));
  }

  /**
   * The AUTHORITATIVE supplier payable from the one ledger: Σ(credit − debit) of `journal_line` rows
   * carrying this party on the AP control account (code 2100) — the balance the register's net-payable
   * totals reconcile to (FR-PUR-021; the trial-balance tie the integration suite asserts).
   */
  async supplierApBalance(supplierId: string, companyId: string): Promise<Decimal> {
    const m = getManager(this.dataSource);
    const [row] = (await m.query(
      `SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS bal
         FROM journal_line jl
         JOIN journal_entry je ON je.id = jl.journal_entry_id
         JOIN account a ON a.id = jl.account_id
        WHERE je.company_id = $1 AND jl.party_id = $2 AND a.code = $3`,
      [companyId, supplierId, WELL_KNOWN_PURCHASE_ACCOUNTS.accountsPayableCode],
    )) as { bal: string }[];
    return new Decimal(row?.bal ?? 0);
  }
}
