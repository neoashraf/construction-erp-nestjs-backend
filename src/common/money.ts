/**
 * Money — a domain value object on decimal.js (ADR-0001 #10, ADR-0002 §2.3, skill §3).
 * EXACT arithmetic only. Never `number`/`parseFloat` on money. Stored as numeric(18,4).
 */
import Decimal from 'decimal.js';

export type Currency = 'BDT';

/** Scale of the money column: numeric(18,4). */
export const MONEY_SCALE = 4;

export class Money {
  private constructor(
    readonly amount: Decimal,
    readonly currency: Currency = 'BDT',
  ) {}

  static of(value: Decimal | string | number, currency: Currency = 'BDT'): Money {
    return new Money(new Decimal(value), currency);
  }

  static zero(currency: Currency = 'BDT'): Money {
    return new Money(new Decimal(0), currency);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  times(factor: Decimal | string | number): Money {
    return new Money(this.amount.times(new Decimal(factor)), this.currency);
  }

  /** Round to the money scale (4 dp) using banker's-safe half-up. */
  round(scale: number = MONEY_SCALE): Money {
    return new Money(this.amount.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP), this.currency);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative();
  }

  isPositive(): boolean {
    return this.amount.isPositive();
  }

  /** Fixed-scale string for persistence / display (e.g. '1500.0000'). */
  toFixed(scale: number = MONEY_SCALE): string {
    return this.amount.toFixed(scale);
  }

  toString(): string {
    return `${this.toFixed()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
