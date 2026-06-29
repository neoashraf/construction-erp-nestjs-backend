/**
 * Maps domain error codes → HTTP status (ADR-0002 §2.3 Error envelope). INFRASTRUCTURE/PRESENTATION
 * concern — the domain throws typed `DomainError`s and never imports Nest's HttpException; this table
 * is the single place that decides their HTTP status.
 */
import { HttpStatus } from '@nestjs/common';
import { DomainErrorCode } from '../../common/errors/domain-error';

export const DOMAIN_ERROR_STATUS: Record<DomainErrorCode, HttpStatus> = {
  [DomainErrorCode.VALIDATION]: HttpStatus.BAD_REQUEST,
  [DomainErrorCode.MISSING_DIMENSION]: HttpStatus.BAD_REQUEST,
  [DomainErrorCode.LEDGER_IMBALANCE]: HttpStatus.BAD_REQUEST,
  [DomainErrorCode.TENANT_SCOPE_MISSING]: HttpStatus.BAD_REQUEST,
  [DomainErrorCode.NUMBERING_EXHAUSTED]: HttpStatus.CONFLICT,
  [DomainErrorCode.PERIOD_CLOSED]: HttpStatus.CONFLICT,
  [DomainErrorCode.CONFLICT]: HttpStatus.CONFLICT,
  [DomainErrorCode.APPEND_ONLY_VIOLATION]: HttpStatus.CONFLICT,
  [DomainErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [DomainErrorCode.UNAUTHORIZED]: HttpStatus.UNAUTHORIZED,
  [DomainErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
};
