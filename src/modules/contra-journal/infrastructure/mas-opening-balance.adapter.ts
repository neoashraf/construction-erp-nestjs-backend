/**
 * MasOpeningBalanceAdapter (INFRASTRUCTURE) — implements OpeningBalanceReader + ControlAccountResolver
 * by reading MAS `account`/`party` opening_balance and resolving the AR/AP-control + opening-equity
 * accounts by the well-known CoA code convention (SRS §15/§16; design open question #2). If a required
 * well-known account is absent, resolution throws OPENING_ACCOUNT_NOT_CONFIGURED. Company-scoped;
 * enrols in the active UoW via getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { AccountType } from '../../../core/posting/domain/posting-command';
import { OpeningAccountNotConfiguredError } from '../domain/errors';
import {
  AccountOpening,
  ControlAccountResolver,
  OpeningBalanceReader,
  PartyOpening,
} from '../domain/ports/opening-balance.port';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { PartyOrmEntity } from '../../master-data/party/infrastructure/party.orm-entity';
import { WELL_KNOWN_ACCOUNTS } from './well-known-accounts';

@Injectable()
export class MasOpeningBalanceAdapter implements OpeningBalanceReader, ControlAccountResolver {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async accountsWithOpening(companyId: string): Promise<AccountOpening[]> {
    const rows = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .createQueryBuilder('a')
      .where('a.company_id = :companyId AND a.opening_balance IS NOT NULL AND a.opening_balance <> 0', {
        companyId,
      })
      .getMany();
    return rows.map((r) => ({
      accountId: r.id,
      type: r.type as AccountType,
      amount: new Decimal(r.openingBalance as Decimal),
    }));
  }

  async partiesWithOpening(companyId: string): Promise<PartyOpening[]> {
    const rows = await getManager(this.dataSource)
      .getRepository(PartyOrmEntity)
      .createQueryBuilder('p')
      .where('p.company_id = :companyId AND p.opening_balance IS NOT NULL AND p.opening_balance <> 0', {
        companyId,
      })
      .getMany();
    return rows.map((r) => ({
      partyId: r.id,
      amount: new Decimal(r.openingBalance as Decimal),
    }));
  }

  arControlAccount(companyId: string): Promise<string> {
    return this.resolveByCode(companyId, WELL_KNOWN_ACCOUNTS.arControlCode, 'accounts-receivable control');
  }

  apControlAccount(companyId: string): Promise<string> {
    return this.resolveByCode(companyId, WELL_KNOWN_ACCOUNTS.apControlCode, 'accounts-payable control');
  }

  openingEquityAccount(companyId: string): Promise<string> {
    return this.resolveByCode(companyId, WELL_KNOWN_ACCOUNTS.openingEquityCode, 'opening-balance-equity');
  }

  private async resolveByCode(companyId: string, code: string, role: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { companyId, code } });
    if (!row) throw new OpeningAccountNotConfiguredError(role);
    return row.id;
  }
}
