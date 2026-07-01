/**
 * IpcConfigAdapter (INFRASTRUCTURE) — implements IpcConfigPort. Supplies the effective IpcRates for a
 * company. Phase-1: MAS exposes no rate-config table yet, so this returns the pending-client defaults
 * (retention 10% / advance 15% / VAT 7.5%, per overview §10 / SRS §15) — held as config constants, NOT
 * hard-coded in the aggregate. When MAS lands a company rate-config service, rebind this adapter to read
 * it; the port and the aggregate stay unchanged (FR-SAL-005..007).
 */
import { Injectable } from '@nestjs/common';
import { IpcRates } from '../domain/rates';
import { IpcConfigPort } from '../domain/ports/ipc-config.port';
import { DEFAULT_IPC_RATES } from './well-known-sales-accounts';

@Injectable()
export class IpcConfigAdapter implements IpcConfigPort {
  async rates(_companyId: string): Promise<IpcRates> {
    void _companyId;
    return IpcRates.of({
      retentionPct: DEFAULT_IPC_RATES.retentionPct,
      advancePct: DEFAULT_IPC_RATES.advancePct,
      vatPct: DEFAULT_IPC_RATES.vatPct,
    });
  }
}
