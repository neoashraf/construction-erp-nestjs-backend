/**
 * Opening-journal source ports (MAS) — the figures + well-known accounts the OpeningJournalAssembler
 * reads (design §2.4/§2.5). PURE interfaces; the MAS adapter (infrastructure) reads `account`/`party`
 * `opening_balance` and resolves the AR/AP-control + opening-balance-equity accounts by CoA convention
 * (SRS §15/§16). GEN never posts these figures itself — it hands a balanced command to PostingService.
 */
import Decimal from 'decimal.js';
import { AccountType } from '../../../../core/posting/domain/posting-command';

/** A MAS account carrying a non-zero opening balance (FR-GEN-010). */
export interface AccountOpening {
  accountId: string;
  type: AccountType;
  /** The opening amount as a signed magnitude in BDT (always the account's natural-side amount). */
  amount: Decimal;
}

/** A MAS party carrying a non-zero opening balance (FR-GEN-011). Sign resolves AR (>0) vs AP (<0). */
export interface PartyOpening {
  partyId: string;
  /**
   * The party's net opening balance. Positive ⇒ the party owes us (AR, debit the AR control account);
   * negative ⇒ we owe the party (AP, credit the AP control account). A party that is both roles is a
   * single signed figure in Phase 1 (a both-roles split is supported by supplying two rows).
   */
  amount: Decimal;
}

export interface OpeningBalanceReader {
  /** Every account with a non-zero opening_balance for the company (FR-GEN-010). */
  accountsWithOpening(companyId: string): Promise<AccountOpening[]>;
  /** Every party with a non-zero opening_balance for the company (FR-GEN-011). */
  partiesWithOpening(companyId: string): Promise<PartyOpening[]>;
}

export const OPENING_BALANCE_READER = Symbol('OpeningBalanceReader');

export interface ControlAccountResolver {
  /** The accounts-receivable control account id (party owes us) — SRS §15/§16. */
  arControlAccount(companyId: string): Promise<string>;
  /** The accounts-payable control account id (we owe the party) — SRS §15/§16. */
  apControlAccount(companyId: string): Promise<string>;
  /** The opening-balance-equity (suspense) account id — the opening journal's balancing line (FR-GEN-010). */
  openingEquityAccount(companyId: string): Promise<string>;
}

export const CONTROL_ACCOUNT_RESOLVER = Symbol('ControlAccountResolver');
