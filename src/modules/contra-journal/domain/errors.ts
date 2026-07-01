/**
 * GEN (Contra & Journal) domain errors (PURE — no Nest). GEN's voucher-shape rejections that LED does
 * not own: the contra bank/cash restriction, the journal conditional-tagging obligations resolved at
 * the draft (defense-in-depth; LED's TagMatrix re-enforces at post), the one-opening-per-company guard,
 * and the DRAFT-only lifecycle guards. Distinct, stable codes (overview §6); the presentation filter
 * maps them to HTTP status.
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** A contra line references an account that is not a bank/cash account (FR-GEN-003). HTTP 400. */
export class NotBankCashAccountError extends DomainError {
  readonly code = DomainErrorCode.NOT_BANK_CASH_ACCOUNT;
  constructor(accountId: string) {
    super(
      `Account ${accountId} is not a bank/cash account; a contra moves money only between the company's own bank/cash accounts (route a party movement to a payment/receipt, or use a journal)`,
      { accountId },
    );
  }
}

/** A contra line carries a party (a contra never touches a party — FR-GEN-003/rule). HTTP 400. */
export class ContraPartyNotAllowedError extends DomainError {
  readonly code = DomainErrorCode.NOT_BANK_CASH_ACCOUNT;
  constructor(accountId: string) {
    super(`A contra line may not carry a party (account ${accountId}); a party movement is a payment/receipt`, {
      accountId,
    });
  }
}

/** A P&L (INCOME/EXPENSE) journal line is missing a required dimension (FR-GEN-005). HTTP 400. */
export class MissingPnlDimensionError extends DomainError {
  readonly code = DomainErrorCode.MISSING_REQUIRED_DIMENSION;
  constructor(accountId: string, dimension: string) {
    super(`${dimension} is required on the P&L line for account ${accountId}`, { accountId, dimension });
  }
}

/** A line on an AR/AP control account is missing a party (FR-GEN-007). HTTP 400. */
export class MissingControlPartyError extends DomainError {
  readonly code = DomainErrorCode.MISSING_CONTROL_PARTY;
  constructor(accountId: string) {
    super(`party_id is required on the AR/AP control-account line for account ${accountId}`, { accountId });
  }
}

/** A voucher's lines do not balance (Σdebit ≠ Σcredit) at the GEN pre-flight (FR-GEN-016). HTTP 400. */
export class UnbalancedEntryError extends DomainError {
  readonly code = DomainErrorCode.UNBALANCED_ENTRY;
  constructor(totalDebit: string, totalCredit: string) {
    super(`Voucher is unbalanced: Σdebit=${totalDebit} ≠ Σcredit=${totalCredit}`, { totalDebit, totalCredit });
  }
}

/** An edit/delete/post attempted on a voucher that is not DRAFT (FR-GEN-014/-018). HTTP 409. */
export class NotDraftError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_POSTED_IMMUTABLE;
  constructor(status: string) {
    super(`Only a DRAFT voucher is editable/postable; this voucher is ${status}`, { status });
  }
}

/** A reverse attempted on a voucher that is not POSTED (FR-GEN-018). HTTP 409. */
export class NotPostedError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_NOT_POSTED;
  constructor(status: string) {
    super(`Only a POSTED voucher can be reversed; this voucher is ${status}`, { status });
  }
}

/** A second opening journal attempted for a company (FR-GEN-012). HTTP 409. */
export class OpeningAlreadyExistsError extends DomainError {
  readonly code = DomainErrorCode.OPENING_ALREADY_EXISTS;
  constructor(companyId: string) {
    super(`An opening journal already exists for company ${companyId}; correct it by reverse-and-repost`, {
      companyId,
    });
  }
}

/** The AR/AP control or opening-balance-equity account could not be resolved in the CoA (SRS §15/§16). HTTP 409. */
export class OpeningAccountNotConfiguredError extends DomainError {
  readonly code = DomainErrorCode.OPENING_ACCOUNT_NOT_CONFIGURED;
  constructor(role: string) {
    super(`The ${role} account is not configured in the chart of accounts; configure it before the opening journal`, {
      role,
    });
  }
}
