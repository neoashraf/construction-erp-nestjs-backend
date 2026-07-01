/**
 * IndicativeRateAdapter (INFRASTRUCTURE) — implements IndicativeRateReadPort by reading INV's append-only
 * `stock_movement` history (the same projection the stock ledger derives — FR-INV-004). The indicative
 * rate for a (godown, item) is the current weighted-average = Σ signed value / Σ signed qty; when the
 * godown holds none (or godown is null), it falls back to the item's LAST-KNOWN movement rate across any
 * godown; absent all history → 0 (FR-REQ-005, edge 14). Used ONLY for the estimate (tiering + advisory
 * budget) — never posted. Enrols in the active UoW via getManager; company-scoped. REQ reads INV's fact
 * table, it writes NO movement (that is brief 2).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { IndicativeRateReadPort } from '../domain/ports/indicative-rate.read.port';

@Injectable()
export class IndicativeRateAdapter implements IndicativeRateReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async currentAvgOrLastKnown(
    companyId: string,
    godownId: string | null,
    itemId: string,
  ): Promise<Decimal> {
    const m = getManager(this.dataSource);

    if (godownId) {
      const rows: Array<{ qty: string | null; val: string | null }> = await m.query(
        `SELECT
           COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0)::text AS qty,
           COALESCE(SUM(CASE WHEN direction = 'IN' THEN value    ELSE -value    END), 0)::text AS val
         FROM stock_movement
        WHERE company_id = $1 AND godown_id = $2 AND item_id = $3`,
        [companyId, godownId, itemId],
      );
      const qty = new Decimal(rows[0]?.qty ?? '0');
      const val = new Decimal(rows[0]?.val ?? '0');
      if (qty.greaterThan(0)) return val.dividedBy(qty).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    }

    // Fallback: the item's last-known movement rate across any godown for this company.
    const last: Array<{ rate: string | null }> = await m.query(
      `SELECT rate::text AS rate
         FROM stock_movement
        WHERE company_id = $1 AND item_id = $2
        ORDER BY posted_at DESC
        LIMIT 1`,
      [companyId, itemId],
    );
    if (last[0]?.rate) return new Decimal(last[0].rate);
    return new Decimal(0);
  }
}
