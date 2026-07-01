/**
 * SalesAccountMapAdapter (INFRASTRUCTURE) — implements SalesAccountMapPort by reading MAS `account` rows
 * (company-scoped) by the well-known CoA code convention, and MAS `project` for the customer resolution.
 * Throws SalesAccountNotConfiguredError if any of the six required accounts is absent (FR-SAL-010; SRS
 * §16). Thin, delegating to the shared DB; adds NO MAS schema. Enrols in the active UoW via getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { SalesAccountMap } from '../domain/ipc-posting';
import { SalesAccountMapPort } from '../domain/ports/sales-account-map.port';
import { SalesAccountNotConfiguredError } from '../domain/errors';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { ProjectOrmEntity } from '../../master-data/project/infrastructure/project.orm-entity';
import { WELL_KNOWN_SALES_ACCOUNTS } from './well-known-sales-accounts';

@Injectable()
export class SalesAccountMapAdapter implements SalesAccountMapPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async resolve(companyId: string): Promise<SalesAccountMap> {
    const [
      accountsReceivable,
      retentionReceivable,
      mobilizationAdvance,
      aitRecoverable,
      revenueConstruction,
      outputVatPayable,
    ] = await Promise.all([
      this.byCode(companyId, WELL_KNOWN_SALES_ACCOUNTS.accountsReceivableCode, 'accounts-receivable control'),
      this.byCode(companyId, WELL_KNOWN_SALES_ACCOUNTS.retentionReceivableCode, 'retention-receivable'),
      this.byCode(companyId, WELL_KNOWN_SALES_ACCOUNTS.mobilizationAdvanceCode, 'mobilization-advance'),
      this.byCode(companyId, WELL_KNOWN_SALES_ACCOUNTS.aitRecoverableCode, 'AIT-recoverable'),
      this.byCode(companyId, WELL_KNOWN_SALES_ACCOUNTS.revenueConstructionCode, 'revenue — construction'),
      this.byCode(companyId, WELL_KNOWN_SALES_ACCOUNTS.outputVatPayableCode, 'output-VAT payable'),
    ]);
    return {
      accountsReceivable,
      retentionReceivable,
      mobilizationAdvance,
      aitRecoverable,
      revenueConstruction,
      outputVatPayable,
    };
  }

  async resolveCustomer(companyId: string, projectId: string): Promise<string | null> {
    const row = await getManager(this.dataSource)
      .getRepository(ProjectOrmEntity)
      .findOne({ where: { id: projectId, companyId } });
    return row ? row.customerId : null;
  }

  private async byCode(companyId: string, code: string, role: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { companyId, code } });
    if (!row) throw new SalesAccountNotConfiguredError(role);
    return row.id;
  }
}
