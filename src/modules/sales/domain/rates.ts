/**
 * IpcRates — the SAL rate value object (PURE domain, no NestJS/TypeORM). Holds the effective
 * retention / advance-recovery / output-VAT percentages an IPC is computed against. Values come from
 * company config (MAS) with the pending-client defaults (retention 10%, advance 15%, per overview §10 /
 * SRS §15) — never hard-coded in the aggregate. Percentages are exact Decimals expressed out of 100
 * (e.g. 10 = 10%). The retention rate is per-IPC overridable (FR-SAL-006); the aggregate records the
 * effective rate for audit.
 */
import Decimal from 'decimal.js';
import { ValidationError } from '../../../common/errors/domain-error';

export class IpcRates {
  private constructor(
    readonly retentionPct: Decimal,
    readonly advancePct: Decimal,
    readonly vatPct: Decimal,
  ) {}

  static of(input: {
    retentionPct: Decimal | string | number;
    advancePct: Decimal | string | number;
    vatPct: Decimal | string | number;
  }): IpcRates {
    return new IpcRates(
      pct(input.retentionPct, 'retentionPct'),
      pct(input.advancePct, 'advancePct'),
      pct(input.vatPct, 'vatPct'),
    );
  }

  /** The fraction (out of 1) form of a percentage, e.g. 10% → 0.10. */
  retentionFraction(): Decimal {
    return this.retentionPct.dividedBy(100);
  }
  advanceFraction(): Decimal {
    return this.advancePct.dividedBy(100);
  }
  vatFraction(): Decimal {
    return this.vatPct.dividedBy(100);
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
