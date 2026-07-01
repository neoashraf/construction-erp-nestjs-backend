/**
 * IpcConfigPort (MAS config, driven). Supplies the effective IpcRates (retention / advance / VAT %) for
 * a company (FR-SAL-005..007). PURE interface; the adapter reads company config, falling back to the
 * pending-client defaults (retention 10%, advance 15%, per overview §10 / SRS §15) — never hard-coded in
 * the aggregate. VAT rate default from the company's Mushak configuration.
 */
import { IpcRates } from '../rates';

export interface IpcConfigPort {
  rates(companyId: string): Promise<IpcRates>;
}

export const IPC_CONFIG_PORT = Symbol('IpcConfigPort');
