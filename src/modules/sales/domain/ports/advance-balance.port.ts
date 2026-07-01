/**
 * AdvanceBalancePort (SAL ledger read, driven). The remaining (un-recovered) mobilization advance for a
 * project+customer = the CREDIT balance on the Mobilization Advance liability account for that party
 * (FR-SAL-008; design open question — RESOLVED: read from the ledger, never a stored field, so it can't
 * drift from the books). Consulted at draft build to cap recovery, and RE-CHECKED inside the post
 * transaction (the authoritative cap). PURE interface; the adapter aggregates `journal_line`.
 */
import { Money } from '../../../../common/money';

export interface AdvanceBalancePort {
  remainingAdvance(companyId: string, projectId: string, customerId: string): Promise<Money>;
}

export const ADVANCE_BALANCE_PORT = Symbol('AdvanceBalancePort');
