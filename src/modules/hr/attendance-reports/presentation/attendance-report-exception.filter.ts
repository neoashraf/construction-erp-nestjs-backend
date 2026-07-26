/**
 * AttendanceReportExceptionFilter — renders the FLAT error body these six routes are contracted to
 * return (REPORTS_MODULE_GUIDE §4.5):
 *
 *   400 → { "error": "dateFrom and dateTo must be supplied together" }
 *   500 → { "error": "Internal server error" }
 *
 * Scoped to `AttendanceReportController` only (`@UseFilters` at class level) — the platform-wide
 * `{ error: { code, message, details }, meta }` envelope from `AllExceptionsFilter` stays the default
 * for every other endpoint. Guard rejections (401/403) are rendered in the same flat shape so a client
 * of these routes never has to parse two error formats. 5xx messages are redacted and the original is
 * logged, exactly as the global filter does.
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ReportBadRequestError } from '../domain/attendance-rules';

interface FlatErrorBody {
  error: string;
}

@Catch()
export class AttendanceReportExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AttendanceReportExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (response.headersSent) return;

    const { status, body } = this.toBody(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url}: ${this.describe(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`Handled error on ${request.method} ${request.url}: ${body.error}`);
    }

    response.status(status).json(body);
  }

  private toBody(exception: unknown): { status: number; body: FlatErrorBody } {
    // The window/date validators in `attendance-rules` — the guide's documented 400s.
    if (exception instanceof ReportBadRequestError) {
      return { status: exception.statusCode, body: { error: exception.message } };
    }

    // body-parser rejects an oversized body before any handler runs; it tags the error rather than
    // throwing an HttpException, so it needs its own branch (SUPPORTING_APIS_GUIDE §1.2).
    if (
      typeof exception === 'object' &&
      exception !== null &&
      (exception as { type?: string }).type === 'entity.too.large'
    ) {
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        body: { error: 'Payload too large' },
      };
    }

    // Guards (401/403) and the ValidationPipe (400 on an unknown query parameter).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        return {
          status,
          body: { error: 'Internal server error' },
        };
      }
      return { status, body: { error: this.messageOf(exception) } };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: 'Internal server error' },
    };
  }

  private messageOf(exception: HttpException): string {
    const res = exception.getResponse();
    if (typeof res === 'string') return res;

    const raw = (res as Record<string, unknown>)['message'];
    // class-validator hands back an array of constraint messages; join so the body stays a string.
    if (Array.isArray(raw)) return raw.join(', ');
    if (typeof raw === 'string') return raw;
    return exception.message;
  }

  private describe(exception: unknown): string {
    if (exception instanceof Error) return `${exception.name}: ${exception.message}`;
    return String(exception);
  }
}
