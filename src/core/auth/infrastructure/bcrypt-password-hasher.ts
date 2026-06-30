/** BcryptPasswordHasher (INFRASTRUCTURE) — bcrypt cost ≥ 10 (FR-AUD-002). */
import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PasswordHasher } from '../domain/ports/password-hasher.port';

const COST_FACTOR = 10;

@Injectable()
export class BcryptPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, COST_FACTOR);
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
