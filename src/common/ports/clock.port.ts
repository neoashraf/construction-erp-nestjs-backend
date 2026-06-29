/**
 * Clock port (skill §4) — the domain reads time through this, never `new Date()` directly,
 * so use cases are deterministic and testable with a fake clock.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');
