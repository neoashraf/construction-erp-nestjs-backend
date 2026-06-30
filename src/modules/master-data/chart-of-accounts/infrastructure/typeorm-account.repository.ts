/** TypeOrmAccountRepository (INFRASTRUCTURE) — company-scoped, version-guarded; company-unique code. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DuplicateCodeError } from '../../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { isUniqueViolation, versionedUpdate } from '../../shared/repo-helpers';
import { AccountType } from '../domain/account-type';
import { Account } from '../domain/account';
import { AccountOrmEntity } from './account.orm-entity';

@Injectable()
export class TypeOrmAccountRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(AccountOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<Account | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }

  /** True if an account is active and in this company (default-account / FK validation). */
  async isActiveInCompany(id: string, companyId: string): Promise<boolean> {
    const r = await this.repo().findOne({ where: { id, companyId, isActive: true }, select: { id: true } });
    return !!r;
  }

  /** True if the account exists in this company (cross-company FK gate, FR-MAS-027/028). */
  async existsInCompany(id: string, companyId: string): Promise<boolean> {
    const r = await this.repo().findOne({ where: { id, companyId }, select: { id: true } });
    return !!r;
  }

  async insert(a: Account): Promise<void> {
    const p = a.props;
    try {
      await this.repo().insert({
        id: a.id,
        companyId: p.companyId,
        code: p.code,
        name: p.name,
        accountGroupId: p.accountGroupId,
        type: p.type,
        openingBalance: p.openingBalance,
        isActive: p.isActive,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateCodeError(p.code);
      throw err;
    }
  }

  async update(a: Account, expectedVersion: number): Promise<void> {
    const p = a.props;
    await versionedUpdate(this.repo(), AccountOrmEntity, a.id, p.companyId, expectedVersion, {
      name: p.name,
      accountGroupId: p.accountGroupId,
      type: p.type,
      openingBalance: p.openingBalance,
      isActive: p.isActive,
    });
  }

  /** Existing account codes for this company (lets the CoA seed skip already-seeded accounts). */
  async existingCodes(companyId: string): Promise<Set<string>> {
    const rows = await this.repo().find({ where: { companyId }, select: { code: true } });
    return new Set(rows.map((r) => r.code));
  }

  /** Idempotent seed insert — ON CONFLICT (company_id, code) DO NOTHING. */
  async seedIfAbsent(a: Account): Promise<void> {
    const p = a.props;
    await getManager(this.dataSource).query(
      `INSERT INTO account (id, company_id, code, name, account_group_id, type, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (company_id, code) DO NOTHING`,
      [a.id, p.companyId, p.code, p.name, p.accountGroupId, p.type],
    );
  }
}

function toDomain(r: AccountOrmEntity): Account {
  return Account.rehydrate(r.id, {
    companyId: r.companyId,
    code: r.code,
    name: r.name,
    accountGroupId: r.accountGroupId,
    type: r.type as AccountType,
    openingBalance: r.openingBalance,
    isActive: r.isActive,
    version: r.version,
  });
}
