/**
 * INV domain errors (PURE — the domain throws these, never Nest's HttpException). They extend the
 * shared `DomainError` so the presentation mapper turns each `code` into an HTTP status
 * (src/infrastructure/http/domain-error.mapping.ts). Brief 1 (stock-ledger core) shipped the
 * negative-stock guard; brief 2 (Stock Journal voucher) adds the mode/side-rule and lifecycle errors
 * below, following the exact style of `NegativeStockError`.
 */
import Decimal from 'decimal.js';
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/**
 * An issue / transfer-out would drive the source `(godown, item)` quantity below zero and the actor
 * does not hold the explicit negative-stock authorisation (FR-INV-014). Maps to HTTP 409
 * `NEGATIVE_STOCK_BLOCKED`. The default policy is block (SRS §6).
 */
export class NegativeStockError extends DomainError {
  readonly code = DomainErrorCode.NEGATIVE_STOCK_BLOCKED;
  constructor(available: Decimal, requested: Decimal, details?: Record<string, unknown>) {
    super(
      `Insufficient stock: requested ${requested.toString()} exceeds on-hand ${available.toString()} and negative stock is not authorised`,
      { available: available.toString(), requested: requested.toString(), ...details },
    );
  }
}

/** A TRANSFER has `fromGodownId === toGodownId` — a no-op move (FR-INV-008, edge 2). HTTP 400. */
export class SameGodownTransferError extends DomainError {
  readonly code = DomainErrorCode.SAME_GODOWN_TRANSFER;
  constructor(godownId: string) {
    super(`A transfer requires fromGodownId to differ from toGodownId (both are ${godownId})`, {
      godownId,
    });
  }
}

/** `…/post` attempted on a journal not in `APPROVED` (FR-INV-012). HTTP 409. */
export class NotApprovedError extends DomainError {
  readonly code = DomainErrorCode.STOCK_JOURNAL_NOT_APPROVED;
  constructor(status: string) {
    super(`Only an APPROVED Stock Journal can be posted; this journal is ${status}`, { status });
  }
}

/** `PATCH`/edit/delete attempted on a non-`DRAFT` Stock Journal (FR-INV-020/-022). HTTP 409. */
export class StockJournalPostedImmutableError extends DomainError {
  readonly code = DomainErrorCode.VOUCHER_POSTED_IMMUTABLE;
  constructor(status: string) {
    super(`Only a DRAFT Stock Journal is editable/deletable; this journal is ${status}`, { status });
  }
}

/** An illegal Stock Journal lifecycle move (e.g. approve a posted journal). HTTP 409. */
export class InvalidStockJournalTransitionError extends DomainError {
  readonly code = DomainErrorCode.INVALID_STOCK_JOURNAL_TRANSITION;
  constructor(from: string, action: string) {
    super(`Illegal Stock Journal transition '${action}' from ${from}`, { from, action });
  }
}

/** `…/reverse` on a journal already cancelled/reversed. HTTP 409. */
export class StockJournalAlreadyReversedError extends DomainError {
  readonly code = DomainErrorCode.ALREADY_REVERSED;
  constructor(id: string) {
    super(`Stock Journal ${id} is already reversed/cancelled`, { id });
  }
}

/** An ISSUE carries a `toGodownId` (only TRANSFER has a to-side). FR-INV-008. HTTP 400. */
export class IssueSideOnTransferOnlyError extends DomainError {
  readonly code = DomainErrorCode.VALIDATION;
  constructor(mode: string) {
    super(`toGodownId is only valid for TRANSFER; mode is ${mode}`, { mode });
  }
}

/**
 * The item's `default_account_id` (inventory account) or the well-known material-expense account
 * could not be resolved in the chart of accounts (architectural decision 1). HTTP 409 — mirrors
 * `HrAccountNotConfiguredError`'s shape.
 */
export class InventoryAccountNotConfiguredError extends DomainError {
  readonly code = DomainErrorCode.INVENTORY_ACCOUNT_NOT_CONFIGURED;
  constructor(role: string) {
    super(`The ${role} account is not configured; configure it before posting a Stock Journal`, {
      role,
    });
  }
}
