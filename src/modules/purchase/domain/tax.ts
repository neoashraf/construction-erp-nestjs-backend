/**
 * PurchaseTax — the PUR rate value object (PURE domain, no NestJS/TypeORM). Holds the effective
 * VAT-input / TDS / AIT percentages a Purchase Bill line is computed against. Values come from company
 * config (MAS) with Phase-1 defaults (VAT input 7.5%, TDS 5%, AIT 2%, per the design §4.1 worked example
 * and CLAUDE.md's "pending client confirmation" convention) — never hard-coded in the aggregate.
 * Percentages are exact Decimals expressed out of 100 (e.g. 7.5 = 7.5%). Each is per-line overridable
 * (FR-PUR-006); the aggregate records the effective amount for audit. Mirrors SAL's `IpcRates` exactly.
 */
import Decimal from 'decimal.js';
import { ValidationError } from '../../../common/errors/domain-error';

export class PurchaseTax {
  private constructor(
    readonly vatInputPct: Decimal,
    readonly tdsPct: Decimal,
    readonly aitPct: Decimal,
  ) {}

  static of(input: {
    vatInputPct: Decimal | string | number;
    tdsPct: Decimal | string | number;
    aitPct: Decimal | string | number;
  }): PurchaseTax {
    return new PurchaseTax(
      pct(input.vatInputPct, 'vatInputPct'),
      pct(input.tdsPct, 'tdsPct'),
      pct(input.aitPct, 'aitPct'),
    );
  }

  /** The fraction (out of 1) form of a percentage, e.g. 7.5% → 0.075. */
  vatInputFraction(): Decimal {
    return this.vatInputPct.dividedBy(100);
  }
  tdsFraction(): Decimal {
    return this.tdsPct.dividedBy(100);
  }
  aitFraction(): Decimal {
    return this.aitPct.dividedBy(100);
  }
}

function pct(value: Decimal | string | number, field: string): Decimal {
  let d: Decimal;
  try {
    d = value instanceof Decimal ? value : new Decimal(value);
  } catch {
    throw new ValidationError(`${field} is not a valid number`, { field, value: String(value) });
  }
  if (!d.isFinite() || d.isNegative()) {
    throw new ValidationError(`${field} must be a finite, non-negative percentage`, { field });
  }
  return d;
}
