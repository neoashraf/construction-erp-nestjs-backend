/**
 * JournalLinePostingsAdapter — stand-in for the `LedgerPostingsQuery` SEAM (FR-MAS-021). INFRASTRUCTURE.
 *
 * Probes `journal_line.account_id` directly (mirroring Project's `isReferencedByTransaction`) so the
 * account-type-immutable guard works before LED exports a dedicated has-postings application service.
 * When LED ships that service, rebind `LEDGER_POSTINGS_QUERY` to it in `master-data.module.ts` and
 * delete this adapter — the use case is unchanged.
 *
 * NOTE: `journal_line` has no `company_id` column (company is on `journal_entry`); the probe is by
 * `account_id`, which is itself company-unique, so the tenant scope is already implied by the account.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { LedgerPostingsQuery } from '../domain/ports/ledger-postings.port';

@Injectable()
export class JournalLinePostingsAdapter implements LedgerPostingsQuery {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async hasPostings(accountId: string): Promise<boolean> {
    const rows: unknown[] = await getManager(this.dataSource).query(
      `SELECT 1 FROM journal_line WHERE account_id = $1 LIMIT 1`,
      [accountId],
    );
    return rows.length > 0;
  }
}
