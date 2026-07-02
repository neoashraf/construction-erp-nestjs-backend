/**
 * PaymentAllocationReadModel (INFRASTRUCTURE) — the canonical per-payable settlement projection (design
 * §5.4): `applied = Σ amount_allocated of PAY's OWN posted, non-reversed payment_allocation rows for a
 * payable`. This is the ONE place the "posted, non-reversed" applied-total SQL lives; it reuses the exact
 * shape proven by `payable-lookup.adapter.ts` (join payment_voucher, guard reversals via the
 * `journal_entry.reversal_of` NOT EXISTS). Company-scoped. Enrols in the active UoW via getManager.
 *
 * Exposes three reads:
 *   - `appliedTo` — single payable applied total (Decimal, 0 when none);
 *   - `appliedForPayables` — batch applied per payable id (one query, `= ANY($ids)`) → Map;
 *   - `applicationsFor` — the settlement trail: the posted, non-reversed payments that settled a payable
 *     (join payment_voucher for entryNo / paymentDate / status).
 * READ-ONLY: no write path, no ledger touch (#28 is the read seam that closes the payment loop).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { PayableType } from '../domain/allocation';

export interface PaymentApplicationRow {
  paymentId: string;
  entryNo: string | null;
  paymentDate: string;
  amountAllocated: string;
  status: string;
}

@Injectable()
export class PaymentAllocationReadModel {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  /** Σ amount_allocated of PAY's OWN posted, non-reversed payments applied to this payable. */
  async appliedTo(payableType: PayableType, payableId: string, companyId: string): Promise<Decimal> {
    const rows: Array<{ applied: string | null }> = await getManager(this.dataSource).query(
      `SELECT COALESCE(SUM(pa.amount_allocated), 0)::text AS applied
         FROM payment_allocation pa
         JOIN payment_voucher pv ON pv.id = pa.payment_voucher_id
        WHERE pv.company_id = $1
          AND pv.status = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.reversal_of = pv.journal_entry_id)
          AND pa.payable_type = $2
          AND pa.payable_id = $3`,
      [companyId, payableType, payableId],
    );
    return new Decimal(rows[0]?.applied ?? '0');
  }

  /** Batch: applied total per payable id (one query). Ids with no posted payment are ABSENT from the map. */
  async appliedForPayables(
    payableType: PayableType,
    ids: string[],
    companyId: string,
  ): Promise<Map<string, Decimal>> {
    const result = new Map<string, Decimal>();
    if (ids.length === 0) return result;
    const rows: Array<{ payable_id: string; applied: string | null }> = await getManager(this.dataSource).query(
      `SELECT pa.payable_id, COALESCE(SUM(pa.amount_allocated), 0)::text AS applied
         FROM payment_allocation pa
         JOIN payment_voucher pv ON pv.id = pa.payment_voucher_id
        WHERE pv.company_id = $1
          AND pv.status = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.reversal_of = pv.journal_entry_id)
          AND pa.payable_type = $2
          AND pa.payable_id = ANY($3)
        GROUP BY pa.payable_id`,
      [companyId, payableType, ids],
    );
    for (const r of rows) result.set(r.payable_id, new Decimal(r.applied ?? '0'));
    return result;
  }

  /** The settlement trail: posted, non-reversed payments that settled this payable (ordered by date/entry). */
  async applicationsFor(
    payableType: PayableType,
    payableId: string,
    companyId: string,
  ): Promise<PaymentApplicationRow[]> {
    const rows: Array<{
      payment_id: string;
      entry_no: string | null;
      payment_date: string;
      amount_allocated: string;
      status: string;
    }> = await getManager(this.dataSource).query(
      `SELECT pv.id AS payment_id,
              pv.entry_no AS entry_no,
              pv.payment_date::text AS payment_date,
              pa.amount_allocated::text AS amount_allocated,
              pv.status AS status
         FROM payment_allocation pa
         JOIN payment_voucher pv ON pv.id = pa.payment_voucher_id
        WHERE pv.company_id = $1
          AND pv.status = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.reversal_of = pv.journal_entry_id)
          AND pa.payable_type = $2
          AND pa.payable_id = $3
        ORDER BY pv.payment_date ASC, pv.entry_no ASC`,
      [companyId, payableType, payableId],
    );
    return rows.map((r) => ({
      paymentId: r.payment_id,
      entryNo: r.entry_no,
      paymentDate: r.payment_date,
      amountAllocated: new Decimal(r.amount_allocated).toFixed(4),
      status: r.status,
    }));
  }
}
