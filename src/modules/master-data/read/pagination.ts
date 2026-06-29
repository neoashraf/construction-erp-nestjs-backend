/**
 * Pagination helpers for the read side (overview §6): request `?page&pageSize` (default pageSize 25),
 * response `{ data, page, pageSize, total }`. PRESENTATION/READ — plain shapes, no aggregates.
 */
export interface PaginatedResult<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PageRequest {
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export function resolvePaging(req: PageRequest): { page: number; pageSize: number; skip: number; take: number } {
  const page = Math.max(1, Math.floor(req.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(req.pageSize ?? DEFAULT_PAGE_SIZE)));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
