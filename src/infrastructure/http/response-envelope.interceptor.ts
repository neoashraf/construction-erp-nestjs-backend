/**
 * ResponseEnvelopeInterceptor (overview §6 — central response model). PRESENTATION adapter.
 *
 * Wraps every 2xx handler return value into the platform success envelope:
 *   - a single resource → `{ data: <resource>, meta: { requestId } }`
 *   - a `Paginated<T>`   → `{ data: <items>, meta: { requestId, page, pageSize, total } }`
 *   - `undefined` (204 / no body) is passed through untouched.
 * `requestId` is the per-request correlation id (pino `req.id`, also the `X-Request-Id` header).
 * The error envelope is produced by the exception filter; together they apply the model platform-wide
 * so per-endpoint code returns only the `data` payload. Routes marked `@NoEnvelope()` are skipped.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { NO_ENVELOPE } from './no-envelope.decorator';
import { Paginated } from './pagination';

interface SuccessEnvelope {
  data: unknown;
  meta: Record<string, unknown>;
}

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(NO_ENVELOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request & { id?: string }>();
    const requestId = req?.id ?? (req?.headers?.['x-request-id'] as string | undefined);

    return next.handle().pipe(
      map((value: unknown): unknown => {
        if (skip || value === undefined) return value; // @NoEnvelope or 204 — leave untouched
        if (value instanceof Paginated) {
          return {
            data: value.items,
            meta: {
              requestId,
              page: value.page,
              pageSize: value.pageSize,
              total: value.total,
              ...(value.extraMeta ?? {}),
            },
          } satisfies SuccessEnvelope;
        }
        return { data: value, meta: { requestId } } satisfies SuccessEnvelope;
      }),
    );
  }
}
