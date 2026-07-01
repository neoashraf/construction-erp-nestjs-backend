/**
 * HrAccountResolverPort (MAS, driven). Resolves the HR posting accounts + the Labour cost centre for a
 * company so the domain never hard-codes account ids (design §2.4). This brief (people-and-attendance)
 * needs only the daily-labour accrual accounts — labour cost + labour payable; the salary accounts are
 * the sibling salary-accrual brief. The MAS adapter resolves them from the well-known CoA codes and
 * throws HrAccountNotConfiguredError when one is absent (design §8 wiring; MAS owns Account/CostCentre —
 * HR reads them and adds no schema).
 */
import { AccrualAccountMap } from '../accrual-command.factory';

export interface HrAccountResolverPort {
  /** The labour-cost + labour-payable account ids for the daily-labour accrual; throws if missing. */
  accrualAccounts(companyId: string): Promise<AccrualAccountMap>;
}

export const HR_ACCOUNT_RESOLVER_PORT = Symbol('HrAccountResolverPort');
