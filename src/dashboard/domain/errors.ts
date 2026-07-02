/**
 * DSH domain errors (FR-DSH-009/-010) — PURE. Thrown by the application layer and mapped to the platform
 * error envelope by AllExceptionsFilter (domain-error.mapping.ts): UnknownTileError → 404, and a tile the
 * role may not see → 403. Project-scope violations reuse RPT's ReportScopeService, which throws Nest's
 * ForbiddenException (FR-DSH-009; mirrors RPT FR-RPT-007), so DSH does not re-define a scope error here.
 */
import { DomainError, DomainErrorCode } from '../../common/errors/domain-error';

/** A tile `key` not present in the catalog (FR-DSH-005) — maps to HTTP 404. */
export class UnknownTileError extends DomainError {
  readonly code = DomainErrorCode.NOT_FOUND;
  constructor(key: string) {
    super(`Unknown dashboard tile '${key}'`, { key });
  }
}

/** A tile requested directly that the caller's role may not see (FR-DSH-010) — maps to HTTP 403. */
export class TileNotPermittedError extends DomainError {
  readonly code = DomainErrorCode.FORBIDDEN;
  constructor(key: string) {
    super(`Tile '${key}' is not visible to this role`, { key });
  }
}
