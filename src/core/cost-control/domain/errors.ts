/**
 * CC domain errors (PURE — no NestJS). CC owns one rule the ledger's per-line checks don't cover:
 * a line's project-scoped tags (purpose / godown) must belong to the line's own project (FR-CC-004).
 * The presentation filter maps `CROSS_PROJECT_DIMENSION` → 400 (domain-error.mapping.ts); the domain
 * never imports Nest's HttpException.
 */
import { DomainError, DomainErrorCode } from '../../../common/errors/domain-error';

/** A voucher line's `purpose`/`godown` belongs to a different project than the line (FR-CC-004). HTTP 400. */
export class CrossProjectDimensionError extends DomainError {
  readonly code = DomainErrorCode.CROSS_PROJECT_DIMENSION;
  constructor(
    dimension: 'purpose' | 'godown',
    dimensionId: string,
    lineProjectId: string,
    ownerProjectId: string | null,
  ) {
    super(
      `${dimension} ${dimensionId} belongs to project ${ownerProjectId ?? 'unknown'}, not the line's project ${lineProjectId}`,
      { dimension, dimensionId, lineProjectId, ownerProjectId },
    );
  }
}
