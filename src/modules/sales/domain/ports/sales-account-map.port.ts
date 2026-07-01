/**
 * SalesAccountMapPort (MAS, driven). Resolves the six sales posting accounts for a company (FR-SAL-010).
 * PURE interface; the MAS adapter resolves account ids from the well-known chart-of-accounts codes and
 * throws SalesAccountNotConfiguredError when one is absent. Also resolves a project's customer party so
 * the use case can tag the AR/retention/advance control lines (customer_id is not client-supplied).
 */
import { SalesAccountMap } from '../ipc-posting';

export interface SalesAccountMapPort {
  /** The six posting-account ids for the company; throws if any well-known account is missing. */
  resolve(companyId: string): Promise<SalesAccountMap>;
  /** The project's customer party id (MAS project.customer_id); null when the project is not the company's. */
  resolveCustomer(companyId: string, projectId: string): Promise<string | null>;
}

export const SALES_ACCOUNT_MAP_PORT = Symbol('SalesAccountMapPort');
