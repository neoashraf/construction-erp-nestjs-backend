/**
 * ResponseEnvelopeInterceptor unit tests (no Nest runtime) — the central success envelope
 * (overview §6): plain value → { data, meta:{requestId} }; Paginated → page info in meta;
 * @NoEnvelope and 204/undefined pass through untouched.
 */
import { CallHandler, ExecutionContext, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { ResponseEnvelopeInterceptor } from '../../src/infrastructure/http/response-envelope.interceptor';
import { Paginated } from '../../src/infrastructure/http/pagination';

function ctxWith(requestId = 'r-1'): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ id: requestId, headers: {} }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}
const handlerOf = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe('ResponseEnvelopeInterceptor', () => {
  function make(skip: boolean): ResponseEnvelopeInterceptor {
    const reflector = { getAllAndOverride: () => skip } as unknown as Reflector;
    return new ResponseEnvelopeInterceptor(reflector);
  }

  it('wraps a plain resource in { data, meta:{requestId} }', async () => {
    const out = await firstValueFrom(make(false).intercept(ctxWith('r-9'), handlerOf({ id: 'c-1' })));
    expect(out).toEqual({ data: { id: 'c-1' }, meta: { requestId: 'r-9' } });
  });

  it('lifts Paginated page info into meta and exposes items as data', async () => {
    const page = new Paginated([{ id: 'a' }, { id: 'b' }], 2, 25, 51);
    const out = await firstValueFrom(make(false).intercept(ctxWith(), handlerOf(page)));
    expect(out).toEqual({
      data: [{ id: 'a' }, { id: 'b' }],
      meta: { requestId: 'r-1', page: 2, pageSize: 25, total: 51 },
    });
  });

  it('passes through untouched when @NoEnvelope is set', async () => {
    const body = { status: 'ok' };
    const out = await firstValueFrom(make(true).intercept(ctxWith(), handlerOf(body)));
    expect(out).toBe(body);
  });

  it('leaves an undefined (204 / no body) response untouched', async () => {
    const out = await firstValueFrom(make(false).intercept(ctxWith(), handlerOf(undefined)));
    expect(out).toBeUndefined();
  });

  it('passes a StreamableFile (binary download) through un-enveloped (RPT export exception)', async () => {
    const file = new StreamableFile(Buffer.from('%PDF-1.4'));
    const out = await firstValueFrom(make(false).intercept(ctxWith(), handlerOf(file)));
    expect(out).toBe(file);
  });
});
