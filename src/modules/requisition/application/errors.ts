/**
 * REQ application-layer errors (PURE — no Nest). Translate the core AccessPolicy's plain Errors
 * (ForbiddenScopeError / OverApprovalLimitError) into the platform's typed DomainError envelope so the
 * presentation filter maps them to the right HTTP status (403). The tier/scope mismatch on approve/reject
 * uses the module-specific ApprovalBeyondAuthorityError (domain); this generic ForbiddenError covers the
 * requester's project-scope check at create/read.
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** The actor is outside the required project scope (FR-AUD-014). HTTP 403. */
export class ForbiddenError extends DomainError {
  readonly code = DomainErrorCode.FORBIDDEN;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}
