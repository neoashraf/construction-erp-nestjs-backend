/**
 * RPT domain errors (SRS §11/§12) — PURE (no NestJS in the domain layer). RPT deliberately reuses the
 * platform's shared domain errors rather than minting new codes: an unknown report name / referenced id is
 * a `NotFoundError` (404); a bad param (unknown format, `dateFrom > dateTo`) is a `ValidationError` (400).
 * A project-scoped user filtering an unassigned `projectId`, or lacking `RPT:READ`, is a Nest
 * `ForbiddenException` (403 — FR-RPT-007/-008), thrown in the application/presentation layers (which may
 * import NestJS) — not re-exported here. No new `DomainErrorCode` is introduced: the read-only reporting
 * layer needs none.
 */
export { ValidationError, NotFoundError } from '../../common/errors/domain-error';
