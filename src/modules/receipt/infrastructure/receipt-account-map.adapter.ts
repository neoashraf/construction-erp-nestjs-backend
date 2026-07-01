/**
 * ReceiptAccountMapAdapter (INFRASTRUCTURE) — implements ReceiptAccountMapPort by reading MAS `account`
 * rows (company-scoped) by the well-known CoA code convention (§16 open question; mirrors
 * HrAccountResolverAdapter / SalesAccountMapAdapter / MasAccountClassificationAdapter). Throws
 * ReceiptAccountNotConfiguredError if the AR or TDS-recoverable account is absent. `generalTargetFacts`
 * classifies a CLIENT-SUPPLIED `generalTargetAccountId` (the API contract: the caller supplies this id
 * directly, it is NOT a well-known-code lookup) — an INCOME account credits with no party; a LIABILITY
 * account is treated as a control line (party-tagged) — the mobilization-advance pattern (design §4.2) —
 * any other account type is not a valid general receipt target. Enrols in the active UoW via getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { GeneralTargetAccountFacts, ReceiptAccountMap } from '../domain/receipt-posting';
import { ReceiptAccountMapPort } from '../domain/ports/receipt-account-map.port';
import { ReceiptAccountNotConfiguredError } from '../domain/errors';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { WELL_KNOWN_RECEIPT_ACCOUNTS } from './well-known-receipt-accounts';

@Injectable()
export class ReceiptAccountMapAdapter implements ReceiptAccountMapPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async resolve(companyId: string): Promise<ReceiptAccountMap> {
    const [accountsReceivable, taxDeductedAtSourceRecoverable] = await Promise.all([
      this.byCode(companyId, WELL_KNOWN_RECEIPT_ACCOUNTS.accountsReceivableCode, 'accounts-receivable control'),
      this.byCode(
        companyId,
        WELL_KNOWN_RECEIPT_ACCOUNTS.taxDeductedAtSourceRecoverableCode,
        'tax-deducted-at-source recoverable',
      ),
    ]);
    return { accountsReceivable, taxDeductedAtSourceRecoverable };
  }

  async generalTargetFacts(companyId: string, accountId: string): Promise<GeneralTargetAccountFacts | null> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { id: accountId, companyId, isActive: true } as never });
    if (!row) return null;
    if (row.type === 'INCOME') {
      return { isControlAccount: false, accountType: 'INCOME' };
    }
    if (row.type === 'LIABILITY') {
      // The advance-from-customer liability (and any other party-owed liability) is a control account.
      return { isControlAccount: true, accountType: 'LIABILITY' };
    }
    return null;
  }

  private async byCode(companyId: string, code: string, role: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { companyId, code } });
    if (!row) throw new ReceiptAccountNotConfiguredError(role);
    return row.id;
  }
}
