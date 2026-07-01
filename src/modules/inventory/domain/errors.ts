/**
 * INV domain errors (PURE — the domain throws these, never Nest's HttpException). They extend the
 * shared `DomainError` so the presentation mapper turns each `code` into an HTTP status
 * (src/infrastructure/http/domain-error.mapping.ts). Brief 1 (stock-ledger core) needs only the
 * negative-stock guard; the voucher-lifecycle errors (NotApproved, SameGodownTransfer, …) land with
 * the Stock Journal voucher in brief 2.
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
