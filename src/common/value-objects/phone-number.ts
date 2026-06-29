/**
 * PhoneNumber — E.164, Bangladesh-first (`+880…`). (CLAUDE.md Bangladesh context, skill §0/§2.2)
 * PURE value object. SMS is a primary channel, so phone numbers are first-class.
 */
import { ValueObject } from '../domain/domain';
import { ValidationError } from '../errors/domain-error';

/** E.164: leading '+', country code starting 1-9, up to 15 digits total. */
const E164 = /^\+[1-9]\d{7,14}$/;

export class PhoneNumber extends ValueObject {
  private constructor(readonly value: string) {
    super();
  }

  static of(raw: string): PhoneNumber {
    const trimmed = raw.trim();
    if (!E164.test(trimmed)) {
      throw new ValidationError(`Invalid E.164 phone number: '${raw}'`, { value: raw });
    }
    return new PhoneNumber(trimmed);
  }

  /** Whether this is a Bangladeshi number (`+880`). */
  isBangladeshi(): boolean {
    return this.value.startsWith('+880');
  }

  override equals(other: PhoneNumber): boolean {
    return this.value === other.value;
  }

  override toString(): string {
    return this.value;
  }
}
