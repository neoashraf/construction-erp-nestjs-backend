/**
 * Result<T, E> — a typed success/failure without throwing, for domain operations whose
 * failure is an expected outcome rather than an exception. (skill §4)
 */
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const Result = {
  ok<T, E = string>(value: T): Result<T, E> {
    return { ok: true, value };
  },
  fail<T, E = string>(error: E): Result<T, E> {
    return { ok: false, error };
  },
  isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
    return r.ok;
  },
  isFail<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
    return !r.ok;
  },
};
