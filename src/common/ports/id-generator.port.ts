/**
 * IdGenerator port (skill §4) — the domain mints UUID primary keys through this; the adapter uses
 * `crypto.randomUUID()`. Keeping it behind a port lets tests inject deterministic ids.
 */
export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');
