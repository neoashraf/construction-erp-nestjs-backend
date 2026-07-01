/**
 * HrAccountResolverAdapter (INFRASTRUCTURE) — implements HrAccountResolverPort.
 *   accrualAccounts() reads MAS `account` rows (company-scoped) by the well-known CoA code convention
 *     (design §8; sibling brief #17).
 *   salaryAccounts()  reads the company-scoped `hr_account_config` role→account/cost-centre mapping (this
 *     brief) — the SIX SALARY roles (GROSS_SALARY/EMPLOYER_PF/SALARY_PAYABLE/TDS_PAYABLE/PF_PAYABLE/
 *     STAFF_ADVANCE_RECOVERY → account_id) + LABOUR_COST_CENTRE (→ cost_centre_id). Unlike the accrual
 *     accounts, salary accounts are NOT identified by a well-known CoA code — the brief calls for a
 *     configurable role→account mapping seeded at go-live (a deployment concern; this adapter and its
 *     migration ship no seed rows).
 * Both throw HrAccountNotConfiguredError for any missing role (design §8; MAS/company owns
 * Account/CostCentre/the mapping — HR reads them and adds no MAS schema). Enrols in the active UoW via
 * getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { AccrualAccountMap } from '../domain/accrual-command.factory';
import { SalaryAccountMap } from '../domain/salary-command.factory';
import { HrAccountResolverPort } from '../domain/ports/hr-account-resolver.port';
import { HrAccountNotConfiguredError } from '../domain/errors';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { WELL_KNOWN_HR_ACCOUNTS } from './well-known-hr-accounts';
import { HrAccountConfigOrmEntity } from './hr-account-config.orm-entity';

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

  async salaryAccounts(companyId: string): Promise<SalaryAccountMap> {
    const [
      grossSalary,
      employerPfContribution,
      salaryPayable,
      tdsPayable,
      pfPayable,
      staffAdvanceRecovery,
      labourCostCentreId,
    ] = await Promise.all([
      this.byRoleAccount(companyId, 'GROSS_SALARY'),
      this.byRoleAccount(companyId, 'EMPLOYER_PF'),
      this.byRoleAccount(companyId, 'SALARY_PAYABLE'),
      this.byRoleAccount(companyId, 'TDS_PAYABLE'),
      this.byRoleAccount(companyId, 'PF_PAYABLE'),
      this.byRoleAccount(companyId, 'STAFF_ADVANCE_RECOVERY'),
      this.byRoleCostCentre(companyId, 'LABOUR_COST_CENTRE'),
    ]);
    return {
      grossSalary,
      employerPfContribution,
      salaryPayable,
      tdsPayable,
      pfPayable,
      staffAdvanceRecovery,
      labourCostCentreId,
    };
  }

  private async byCode(companyId: string, code: string, role: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { companyId, code } });
    if (!row) throw new HrAccountNotConfiguredError(role);
    return row.id;
  }

  private async byRoleAccount(companyId: string, role: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(HrAccountConfigOrmEntity)
      .findOne({ where: { companyId, role } as never });
    if (!row || !row.accountId) throw new HrAccountNotConfiguredError(role);
    return row.accountId;
  }

  private async byRoleCostCentre(companyId: string, role: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(HrAccountConfigOrmEntity)
      .findOne({ where: { companyId, role } as never });
    if (!row || !row.costCentreId) throw new HrAccountNotConfiguredError(role);
    return row.costCentreId;
  }
}
