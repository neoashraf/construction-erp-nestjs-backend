/**
 * Global exception filter (ADR-0002 §2.3 Error envelope, overview §6). PRESENTATION adapter.
 *
 * Emits the platform error envelope for EVERY error:
 *   { "error": { "code": "STRING_CODE", "message": "human-readable", "details": {} } }
 * Mapping:
 *   - `DomainError`   → its `code` + mapped HTTP status + `details`.
 *   - Nest `HttpException` → a derived code + its status (validation errors keep their messages).
 *   - anything else   → 500 INTERNAL_ERROR, message redacted (never leak internals/PII).
 * The original error is logged (with the request correlation id) for diagnosis.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { DomainError } from '../../common/errors/domain-error';
import { DOMAIN_ERROR_STATUS } from './domain-error.mapping';

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
  meta: {
    requestId?: string;
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, body } = this.toEnvelope(exception);
    // Stamp the per-request correlation id into meta (overview §6) — same id as X-Request-Id.
    body.meta = {
      requestId:
        (request as Request & { id?: string }).id ??
        (request.headers['x-request-id'] as string | undefined),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url}: ${this.describe(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `Handled error on ${request.method} ${request.url}: ${body.error.code} — ${body.error.message}`,
      );
    }

    response.status(status).json(body);
  }

  private toEnvelope(exception: unknown): { status: number; body: ErrorEnvelope } {
    // 1. Domain errors — typed code + mapped status.
    if (exception instanceof DomainError) {
      const status = DOMAIN_ERROR_STATUS[exception.code] ?? HttpStatus.BAD_REQUEST;
      return {
        status,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            details: exception.details ?? {},
          },
          meta: {},
        },
      };
    }

    // 2. Nest HttpException — derive a code from the status; preserve validation detail.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const { message, details } = this.fromHttpExceptionResponse(res);
      return {
        status,
        body: {
          error: {
            code: this.codeFromStatus(status),
            message,
            details,
          },
          meta: {},
        },
      };
    }

    // 3. Anything else — opaque 500, internals redacted.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
          details: {},
        },
        meta: {},
      },
    };
  }

  private fromHttpExceptionResponse(res: string | object): {
    message: string;
    details: Record<string, unknown>;
  } {
    if (typeof res === 'string') {
      return { message: res, details: {} };
    }
    const record = res as Record<string, unknown>;
    const rawMessage = record['message'];
    // class-validator yields an array of constraint messages — surface them in details.
    if (Array.isArray(rawMessage)) {
      return { message: 'Validation failed', details: { messages: rawMessage } };
    }
    return {
      message: typeof rawMessage === 'string' ? rawMessage : 'Request failed',
      details: {},
    };
  }

  private codeFromStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'UNPROCESSABLE_ENTITY';
      default:
        return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
    }
  }

  private describe(exception: unknown): string {
    if (exception instanceof Error) return `${exception.name}: ${exception.message}`;
    return String(exception);
  }
}
