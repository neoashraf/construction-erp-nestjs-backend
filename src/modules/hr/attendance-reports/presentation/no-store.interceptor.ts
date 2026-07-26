/**
 * NoStoreInterceptor — stamps `Cache-Control: no-store` on the attendance report/config responses
 * (SUPPORTING_APIS_GUIDE §1.2). Attendance data changes as punches arrive, so a cached
 * `/api/reports/daily` or a cached device status is a wrong answer, not a fast one.
 *
 * Scoped to these controllers rather than installed globally: the source project set the header on every
 * response because the whole service WAS the attendance API. Here it would change caching behaviour for
 * the entire ERP, which is not this change's business.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';

@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<Response>();
    // Set BEFORE the handler runs, so it also lands on routes that write the response themselves
    // (the CSV export routes use @Res()).
    if (!res.headersSent) res.setHeader('Cache-Control', 'no-store');
    return next.handle();
  }
}
