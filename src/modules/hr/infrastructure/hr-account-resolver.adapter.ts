/**
 * HrAccountResolverAdapter (INFRASTRUCTURE) — implements HrAccountResolverPort by reading MAS `account`
 * rows (company-scoped) by the well-known CoA code convention. Throws HrAccountNotConfiguredError if the
 * labour-cost or labour-payable account is absent (design §8; MAS owns Account — HR reads it and adds NO
 * schema). Enrols in the active UoW via getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { AccrualAccountMap } from '../domain/accrual-command.factory';
import { HrAccountResolverPort } from '../domain/ports/hr-account-resolver.port';
import { HrAccountNotConfiguredError } from '../domain/errors';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { WELL_KNOWN_HR_ACCOUNTS } from './well-known-hr-accounts';

@Injectable()
export class HrAccountResolverAdapter implements HrAccountResolverPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async accrualAccounts(companyId: string): Promise<AccrualAccountMap> {
    const [labourCost, labourPayable] = await Promise.all([
      this.byCode(companyId, WELL_KNOWN_HR_ACCOUNTS.labourCostCode, 'labour-cost'),
      this.byCode(companyId, WELL_KNOWN_HR_ACCOUNTS.labourPayableCode, 'labour-payable'),
    ]);
    return { labourCost, labourPayable };
  }

  private async byCode(companyId: string, code: string, role: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { companyId, code } });
    if (!row) throw new HrAccountNotConfiguredError(role);
    return row.id;
  }
}
