/**
 * Decimal column transformers (skill §3, ADR-0002 §2.3 Money) — INFRASTRUCTURE.
 *
 * TypeORM returns `numeric` columns as JS strings; these map them to/from decimal.js so money and
 * quantities are EXACT end-to-end. `to` writes a fixed-scale string (so PG stores the exact scale);
 * `from` lifts the DB string into a `Decimal`. Never let a money value become a JS `number`.
 */
import Decimal from 'decimal.js';
import { ValueTransformer } from 'typeorm';

export const decimalTransformer = (scale: number): ValueTransformer => ({
  to: (value?: Decimal | string | number | null): string | null =>
    value == null ? null : new Decimal(value).toFixed(scale),
  from: (value?: string | null): Decimal | null => (value == null ? null : new Decimal(value)),
});

/** money / rate / value columns — numeric(18,4). */
export const moneyTransformer = decimalTransformer(4);

/** quantity columns — numeric(18,3). */
export const qtyTransformer = decimalTransformer(3);
