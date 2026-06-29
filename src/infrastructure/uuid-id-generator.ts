/**
 * UuidIdGenerator — the `IdGenerator` port adapter using Node's built-in `crypto.randomUUID()`
 * (Node ≥ 20, skill §1). INFRASTRUCTURE. UUID v4 primary keys (CLAUDE.md "UUID primary keys").
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { IdGenerator } from '../common/ports/id-generator.port';

@Injectable()
export class UuidIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
