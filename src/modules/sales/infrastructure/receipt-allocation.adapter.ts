/**
 * ReceiptAllocationAdapter (INFRASTRUCTURE) — implements ReceiptAllocationPort by reading REC's
 * `receipt_allocation` VIEW directly (REC migration 1700001600000-CreateReceipt; REC exports no
 * repository/service — the established cross-module read pattern, e.g. MasAccountClassificationAdapter
 * reading MAS's AccountOrmEntity, or REC's own IpcReferenceAdapter reading SAL's IpcOrmEntity). The view
 * already selects posted, non-reversed IPC-linked receipts only, so a reversed/cancelled receipt drops out
 * automatically — `appliedToIpc` needs no reversal-aware filtering of its own (design §5.3).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Money } from '../../../common/money';
import { ReceiptAllocationPort } from '../domain/ports/receipt-allocation.port';

@Injectable()
export class ReceiptAllocationAdapter implements ReceiptAllocationPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async appliedToIpc(ipcId: string, companyId: string): Promise<Money> {
    void companyId; // receipt_allocation carries no company_id column; SAL scopes the IPC lookup itself.
    const rows: Array<{ applied: string | null }> = await getManager(this.dataSource).query(
      `SELECT COALESCE(SUM(amount_applied), 0)::text AS applied FROM receipt_allocation WHERE ipc_id = $1`,
      [ipcId],
    );
    return Money.of(new Decimal(rows[0]?.applied ?? '0'));
  }
}
