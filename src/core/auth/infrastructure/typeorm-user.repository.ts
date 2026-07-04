/** TypeOrmUserRepository (INFRASTRUCTURE) — company-scoped; saves via active UoW transaction. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { User } from '../domain/user';
import { UserRepository } from '../domain/ports/user.repository.port';
import { UserOrmEntity } from './user.orm-entity';

@Injectable()
export class TypeOrmUserRepository implements UserRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return getManager(this.dataSource).getRepository(UserOrmEntity);
  }

  async findByEmail(companyId: string, email: string): Promise<User | null> {
    const normalizedEmail = email.toLowerCase().trim();
    // Phase-1 single-company: if no companyId supplied, search globally by email.
    const where = companyId
      ? { companyId, email: normalizedEmail }
      : { email: normalizedEmail };
    const r = await this.repo().findOne({ where });
    return r ? toDomain(r) : null;
  }

  async findById(id: string): Promise<User | null> {
    const r = await this.repo().findOne({ where: { id } });
    return r ? toDomain(r) : null;
  }

  async save(user: User): Promise<void> {
    const p = user.props;
    const existing = await this.repo().findOne({ where: { id: user.id } });
    if (existing) {
      await this.repo().update({ id: user.id }, {
        passwordHash: p.passwordHash,
        name: p.name,
        role: p.role,
        isActive: p.isActive,
        mustChangePassword: p.mustChangePassword,
        lastLoginAt: p.lastLoginAt,
        phone: p.phone,
        failedLoginAttempts: p.failedLoginAttempts,
        lockedUntil: p.lockedUntil,
      });
    } else {
      await this.repo().insert({
        id: user.id,
        companyId: p.companyId,
        financialYearId: p.financialYearId,
        email: p.email,
        passwordHash: p.passwordHash,
        name: p.name,
        role: p.role,
        isActive: p.isActive,
        mustChangePassword: p.mustChangePassword,
        lastLoginAt: p.lastLoginAt,
        phone: p.phone,
        failedLoginAttempts: p.failedLoginAttempts,
        lockedUntil: p.lockedUntil,
      });
    }
  }
}

function toDomain(r: UserOrmEntity): User {
  return User.rehydrate(r.id, {
    companyId: r.companyId,
    financialYearId: r.financialYearId,
    email: r.email,
    passwordHash: r.passwordHash,
    name: r.name,
    role: r.role,
    isActive: r.isActive,
    mustChangePassword: r.mustChangePassword,
    lastLoginAt: r.lastLoginAt,
    phone: r.phone,
    failedLoginAttempts: r.failedLoginAttempts,
    lockedUntil: r.lockedUntil,
    version: r.version,
  });
}
