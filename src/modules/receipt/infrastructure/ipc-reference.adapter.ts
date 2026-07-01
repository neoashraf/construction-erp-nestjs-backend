/**
 * IpcReferenceAdapter (INFRASTRUCTURE) — implements IpcReferencePort by reading SAL's IpcOrmEntity
 * directly (SalesModule exports no repository — mirrors MasAccountClassificationAdapter's cross-module
 * ORM-entity read of MAS's AccountOrmEntity). `outstandingForIpc` computes SAL's exact formula
 * (currentlyDueAmount - Sigma(amountSettled) of POSTED, non-reversed IPC-linked receipts referencing this
 * IPC) directly against REC's OWN `receipt` table — the same formula the `receipt_allocation` view
 * encodes (design §2.5/§5.3), computed in SQL here instead of via the view so it works mid-transaction
 * without depending on the view's snapshot semantics. Enrols in the active UoW via getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Money } from '../../../common/money';
import { IpcRef, IpcReferencePort } from '../domain/ports/ipc-reference.port';
import { IpcOrmEntity } from '../../sales/infrastructure/ipc.orm-entity';

@Injectable()
export class IpcReferenceAdapter implements IpcReferencePort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async findPostedIpc(ipcId: string, companyId: string): Promise<IpcRef | null> {
    const row = await getManager(this.dataSource)
      .getRepository(IpcOrmEntity)
      .findOne({ where: { id: ipcId, companyId } });
    if (!row) return null;
    return {
      id: row.id,
      companyId: row.companyId,
      projectId: row.projectId,
      customerId: row.customerId,
      costCentreId: row.costCentreId,
      purposeId: row.purposeId,
      status: row.status,
      currentlyDueAmount: Money.of(new Decimal(row.currentlyDueAmount)),
    };
  }

  async outstandingForIpc(ipcId: string, companyId: string): Promise<Money> {
    const m = getManager(this.dataSource);
    const ipc = await m.getRepository(IpcOrmEntity).findOne({ where: { id: ipcId, companyId } });
    if (!ipc) return Money.zero();

    // Sigma(amount_settled) of POSTED, non-reversed IPC-linked receipts referencing this IPC — the exact
    // formula the receipt_allocation view encodes (design §5.3), computed directly against REC's table.
    const rows: Array<{ applied: string | null }> = await m.query(
      `SELECT COALESCE(SUM(r.amount_settled), 0)::text AS applied
         FROM receipt r
         JOIN journal_entry je ON je.id = r.journal_entry_id
        WHERE r.company_id = $1
          AND r.ipc_id = $2
          AND r.receipt_type = 'IPC_LINKED'
          AND r.status = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM journal_entry rev WHERE rev.reversal_of = je.id)`,
      [companyId, ipcId],
    );
    const applied = new Decimal(rows[0]?.applied ?? '0');
    const outstanding = new Decimal(ipc.currentlyDueAmount).minus(applied);
    return Money.of(outstanding.isNegative() ? new Decimal(0) : outstanding);
  }
}
