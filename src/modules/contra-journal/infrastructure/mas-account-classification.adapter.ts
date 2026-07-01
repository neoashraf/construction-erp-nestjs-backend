/**
 * MasAccountClassificationAdapter (INFRASTRUCTURE) — implements the AccountClassification port by
 * reading MAS `account` rows (company-scoped). Resolves `type` from account.type and the cash/bank +
 * AR/AP-control flags from the well-known CoA code convention (SRS §16; design open question #1). Thin,
 * delegating to the shared DB; no MAS schema is added here. Enrols in the active UoW via getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { AccountType } from '../../../core/posting/domain/posting-command';
import {
  AccountClassification,
  AccountFacts,
} from '../domain/ports/account-classification.port';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { WELL_KNOWN_ACCOUNTS } from './well-known-accounts';

@Injectable()
export class MasAccountClassificationAdapter implements AccountClassification {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async factsOf(companyId: string, accountId: string): Promise<AccountFacts> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { id: accountId, companyId } });
    if (!row) return { type: null, isCashBank: false, isArApControl: false };
    return {
      type: row.type as AccountType,
      isCashBank: (WELL_KNOWN_ACCOUNTS.cashBankCodes as readonly string[]).includes(row.code),
      isArApControl:
        row.code === WELL_KNOWN_ACCOUNTS.arControlCode || row.code === WELL_KNOWN_ACCOUNTS.apControlCode,
    };
  }
}
