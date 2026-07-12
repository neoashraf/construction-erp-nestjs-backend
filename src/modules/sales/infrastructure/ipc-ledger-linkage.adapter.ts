/**
 * IpcLedgerLinkageAdapter (INFRASTRUCTURE) — implements IpcLedgerLinkagePort by reading LED's append-only
 * `journal_entry` table directly (LED exports no repository/service to SAL — the established cross-module
 * read pattern: AdvanceBalanceAdapter over `journal_line`, ReceiptAllocationAdapter over
 * `receipt_allocation`). Filters to this IPC's ledger footprint via the `idx_journal_entry_source` index
 * (`source_type = 'SalesInvoice'`, `source_id = ipcId`). Ordered by `created_at` then `entry_no`: a
 * repost writes its reversal + corrected in ONE transaction (identical `now()` timestamp), so `entry_no`
 * — allocated gaplessly in creation order (reversal before the corrected post) — is the tie-breaker that
 * keeps the chain in true posting order.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { IPC_SOURCE_TYPE } from '../domain/ipc';
import { IpcLedgerEntryRef, IpcLedgerLinkagePort } from '../domain/ports/ipc-ledger-linkage.port';

@Injectable()
export class IpcLedgerLinkageAdapter implements IpcLedgerLinkagePort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async entriesForIpc(ipcId: string, companyId: string): Promise<IpcLedgerEntryRef[]> {
    const rows: Array<{
      id: string;
      entry_no: string;
      is_reversal: boolean;
      reversal_of: string | null;
      created_at: Date;
    }> = await getManager(this.dataSource).query(
      `SELECT id, entry_no, is_reversal, reversal_of, created_at
         FROM journal_entry
        WHERE company_id = $1 AND source_type = $2 AND source_id = $3
        ORDER BY created_at ASC, entry_no ASC`,
      [companyId, IPC_SOURCE_TYPE, ipcId],
    );
    return rows.map((r) => ({
      entryId: r.id,
      entryNo: r.entry_no,
      isReversal: r.is_reversal,
      reversalOfEntryId: r.reversal_of,
      postedAt: new Date(r.created_at).toISOString(),
    }));
  }
}
