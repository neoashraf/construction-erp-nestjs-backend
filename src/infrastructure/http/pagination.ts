/**
 * Pagination primitives for the central response model (overview §6). A `read/` query service returns
 * `Paginated<T>`; the ResponseEnvelopeInterceptor lifts the page info into `meta`
 * (`{ data: items, meta: { requestId, page, pageSize, total } }`) so controllers/read-services never
 * hand-assemble the envelope. Request `?page&pageSize` (default pageSize 25).
 */
export class Paginated<T> {
  constructor(
    readonly items: T[],
    readonly page: number,
    readonly pageSize: number,
    readonly total: number,
  ) {}
}

export interface PageRequest {
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export function resolvePaging(
  req: PageRequest,
): { page: number; pageSize: number; skip: number; take: number } {
  const page = Math.max(1, Math.floor(req.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(req.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
