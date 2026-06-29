/**
 * TIN — Bangladesh Taxpayer Identification Number (NBR). 12 digits. (CLAUDE.md Bangladesh context)
 * PURE value object.
 */
import { ValueObject } from '../domain/domain';
import { ValidationError } from '../errors/domain-error';

const TIN_PATTERN = /^\d{12}$/;

export class Tin extends ValueObject {
  private constructor(readonly value: string) {
    super();
  }

  static of(raw: string): Tin {
    const trimmed = raw.trim();
    if (!TIN_PATTERN.test(trimmed)) {
      throw new ValidationError(`Invalid TIN (expected 12 digits): '${raw}'`, { value: raw });
    }
    return new Tin(trimmed);
  }

  override equals(other: Tin): boolean {
    return this.value === other.value;
  }

  override toString(): string {
    return this.value;
  }
}
