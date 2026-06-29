/**
 * BIN — Bangladesh Business Identification Number (NBR VAT registration, Mushak). 13 digits.
 * (CLAUDE.md Bangladesh context) PURE value object.
 */
import { ValueObject } from '../domain/domain';
import { ValidationError } from '../errors/domain-error';

const BIN_PATTERN = /^\d{13}$/;

export class Bin extends ValueObject {
  private constructor(readonly value: string) {
    super();
  }

  static of(raw: string): Bin {
    const trimmed = raw.trim();
    if (!BIN_PATTERN.test(trimmed)) {
      throw new ValidationError(`Invalid BIN (expected 13 digits): '${raw}'`, { value: raw });
    }
    return new Bin(trimmed);
  }

  override equals(other: Bin): boolean {
    return this.value === other.value;
  }

  override toString(): string {
    return this.value;
  }
}
