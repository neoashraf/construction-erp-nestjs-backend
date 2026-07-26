/**
 * DevicePlainTextExceptionFilter — the `/iclock/cdata` error contract (SUPPORTING_APIS_GUIDE §5.2).
 *
 * ZKTeco firmware treats ANY response other than plain-text `OK` as a failed upload and re-sends the
 * same batch, forever. A JSON error body — which is what every other filter in this app produces — would
 * therefore turn one bad request into an infinite retry loop that also never surfaces to an operator.
 *
 * So this filter answers `200 OK` in plain text for everything, and LOGS the real error instead. That
 * includes an oversized body: replying 413 would just make the device retry the same oversized batch.
 * Nothing is silently lost — punches already committed to `checkin_log` are durable, and the log line
 * carries the actual failure for whoever is watching the device.
 *
 * Scoped to `DeviceIngestionController` only. Operator-facing routes use
 * `AttendanceReportExceptionFilter`, which surfaces real status codes.
 */
import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class DevicePlainTextExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DevicePlainTextExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    this.logger.error(
      `Device request failed on ${request.method} ${request.originalUrl}: ${this.describe(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    if (response.headersSent) return;
    response.status(200).type('text/plain').send('OK');
  }

  private describe(exception: unknown): string {
    if (exception instanceof Error) return `${exception.name}: ${exception.message}`;
    return String(exception);
  }
}
