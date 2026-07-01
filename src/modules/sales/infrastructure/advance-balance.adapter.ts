/**
 * AdvanceBalanceAdapter (INFRASTRUCTURE) — implements AdvanceBalancePort. The remaining (un-recovered)
 * mobilization advance for a project+customer = the NET CREDIT balance on the Mobilization Advance
 * liability account for that party, read from the ledger `journal_line` (FR-SAL-008; design open question
 * RESOLVED — a ledger read, never a stored field, so it can't drift from the books). A REC advance
 * receipt credits the account (increasing the remaining); each IPC recovery debits it (reducing it).
 * remaining = Σcredit − Σdebit (floored at 0). Enrols in the active UoW via getManager; company-scoped.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Money } from '../../../common/money';
import { AdvanceBalancePort } from '../domain/ports/advance-balance.port';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { WELL_KNOWN_SALES_ACCOUNTS } from './well-known-sales-accounts';

@Injectable()
export class AdvanceBalanceAdapter implements AdvanceBalancePort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async remainingAdvance(companyId: string, projectId: string, customerId: string): Promise<Money> {
    const m = getManager(this.dataSource);
    const account = await m
      .getRepository(AccountOrmEntity)
      .findOne({ where: { companyId, code: WELL_KNOWN_SALES_ACCOUNTS.mobilizationAdvanceCode } });
    // No advance account configured / no advance liability ⇒ nothing to recover against.
    if (!account) return Money.zero();

    // Net credit balance for this party+project on the advance-liability account across POSTED entries.
    const rows: Array<{ dr: string | null; cr: string | null }> = await m.query(
      `SELECT COALESCE(SUM(l.debit),0)::text AS dr, COALESCE(SUM(l.credit),0)::text AS cr
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.journal_entry_id
        WHERE e.company_id = $1
          AND l.account_id = $2
          AND l.party_id = $3
          AND l.project_id = $4`,
      [companyId, account.id, customerId, projectId],
    );
    const dr = new Decimal(rows[0]?.dr ?? '0');
    const cr = new Decimal(rows[0]?.cr ?? '0');
    const remaining = cr.minus(dr);
    return Money.of(remaining.isNegative() ? new Decimal(0) : remaining);
  }
}
