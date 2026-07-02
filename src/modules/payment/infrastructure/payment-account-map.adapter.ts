/**
 * PaymentAccountMapAdapter (INFRASTRUCTURE) — implements PaymentAccountMapPort by reading MAS `account`
 * rows (company-scoped) by the well-known CoA code convention. Resolves the labour cost account ('5110')
 * and the bank charges account ('6200'); throws PaymentAccountNotConfiguredError if either is absent.
 * Enrols in the active UoW via getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { PaymentAccountMapPort } from '../domain/ports/payment-account-map.port';
import { PaymentAccountNotConfiguredError } from '../domain/errors';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { WELL_KNOWN_PAYMENT_ACCOUNTS } from './well-known-payment-accounts';

@Injectable()
export class PaymentAccountMapAdapter implements PaymentAccountMapPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async resolve(companyId: string): Promise<{ labourCostAccountId: string; bankChargesAccountId: string }> {
    const [labourCostAccountId, bankChargesAccountId] = await Promise.all([
      this.byCode(companyId, WELL_KNOWN_PAYMENT_ACCOUNTS.labourCostCode, 'labour cost'),
      this.byCode(companyId, WELL_KNOWN_PAYMENT_ACCOUNTS.bankChargesCode, 'bank charges'),
    ]);
    return { labourCostAccountId, bankChargesAccountId };
  }

  private async byCode(companyId: string, code: string, role: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { companyId, code } });
    if (!row) throw new PaymentAccountNotConfiguredError(role);
    return row.id;
  }
}
