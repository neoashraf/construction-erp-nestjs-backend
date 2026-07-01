/**
 * HrAccountResolverPort (MAS, driven). Resolves the HR posting accounts + the Labour cost centre for a
 * company so the domain never hard-codes account ids (design §2.4). `accrualAccounts` backs the
 * daily-labour accrual (sibling brief #17); `salaryAccounts` (this brief) resolves the SIX SALARY posting
 * roles — gross salary, employer PF, salary payable, TDS payable, PF payable, staff-advance-recovery — plus
 * the Labour cost centre id, all from the SAME per-company `hr_account_config` mapping (one port, extended
 * — NOT a parallel second port). The adapter throws HrAccountNotConfiguredError for any missing role,
 * mirroring accrualAccounts()'s error-on-missing pattern exactly (design §8 wiring; MAS owns
 * Account/CostCentre — HR reads them and adds no MAS schema, only its own role→account mapping table).
 */
import { AccrualAccountMap } from '../accrual-command.factory';
import { SalaryAccountMap } from '../salary-command.factory';

export interface HrAccountResolverPort {
  /** The labour-cost + labour-payable account ids for the daily-labour accrual; throws if missing. */
  accrualAccounts(companyId: string): Promise<AccrualAccountMap>;

  /** The six SALARY posting account ids + the Labour cost centre id; throws if any role is unconfigured. */
  salaryAccounts(companyId: string): Promise<SalaryAccountMap>;
}

export const HR_ACCOUNT_RESOLVER_PORT = Symbol('HrAccountResolverPort');
