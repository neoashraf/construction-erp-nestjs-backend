/**
 * AccountClassification port (MAS) — the single lookup GEN's tagging + contra restriction need (design
 * §2.2). PURE interface; the MAS adapter (infrastructure) resolves it from `account.type` plus the
 * chart-of-accounts grouping/code convention that marks cash/bank and AR/AP control accounts (SRS §16).
 *
 * The method is async because the adapter reads MAS. GEN's aggregates take a resolved, in-memory
 * snapshot (`AccountClassificationSnapshot`) so the pure aggregate never performs IO.
 */
import { AccountType } from '../../../../core/posting/domain/posting-command';

/** Resolved facts about one account. `type = null` ⇒ the account was not found for the company. */
export interface AccountFacts {
  type: AccountType | null;
  /** A bank/cash ASSET account — gates the contra restriction (FR-GEN-003). */
  isCashBank: boolean;
  /** An accounts-receivable / accounts-payable control account — gates the party rule (FR-GEN-007). */
  isArApControl: boolean;
}

export interface AccountClassification {
  /** Classify one account for the company (type + cash/bank flag + AR/AP-control flag). */
  factsOf(companyId: string, accountId: string): Promise<AccountFacts>;
}

export const ACCOUNT_CLASSIFICATION = Symbol('AccountClassification');

/**
 * A resolved, in-memory classification of the accounts a voucher touches, keyed by accountId. The
 * application layer builds this (via `AccountClassification`) BEFORE constructing the pure aggregate, so
 * the aggregate applies the §5.1 tagging rules with no IO.
 */
export class AccountClassificationSnapshot {
  constructor(private readonly facts: ReadonlyMap<string, AccountFacts>) {}

  static async load(
    classify: AccountClassification,
    companyId: string,
    accountIds: readonly string[],
  ): Promise<AccountClassificationSnapshot> {
    const map = new Map<string, AccountFacts>();
    for (const id of new Set(accountIds)) {
      map.set(id, await classify.factsOf(companyId, id));
    }
    return new AccountClassificationSnapshot(map);
  }

  /** For tests / assembler: build a snapshot from an explicit map. */
  static of(facts: Record<string, AccountFacts>): AccountClassificationSnapshot {
    return new AccountClassificationSnapshot(new Map(Object.entries(facts)));
  }

  factsFor(accountId: string): AccountFacts {
    return this.facts.get(accountId) ?? { type: null, isCashBank: false, isArApControl: false };
  }
}
