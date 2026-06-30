/** TypeOrmCostCentreRepository (INFRASTRUCTURE) — company-scoped, version-guarded. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DuplicateCodeError } from '../../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { isUniqueViolation, versionedUpdate } from '../../shared/repo-helpers';
import { CostCentre } from '../domain/cost-centre';
import { CostCentreOrmEntity } from './cost-centre.orm-entity';

@Injectable()
export class TypeOrmCostCentreRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(CostCentreOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<CostCentre | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? CostCentre.rehydrate(r.id, { ...r }) : null;
  }

  /** True if a cost centre is active and in this company (for budget validation). */
  async isActiveInCompany(id: string, companyId: string): Promise<boolean> {
    const r = await this.repo().findOne({ where: { id, companyId, isActive: true }, select: { id: true } });
    return !!r;
  }

  async insert(cc: CostCentre): Promise<void> {
    const p = cc.props;
    try {
      await this.repo().insert({ id: cc.id, companyId: p.companyId, code: p.code, name: p.name, isActive: p.isActive });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateCodeError(p.code);
      throw err;
    }
  }

  async update(cc: CostCentre, expectedVersion: number): Promise<void> {
    const p = cc.props;
    await versionedUpdate(this.repo(), CostCentreOrmEntity, cc.id, p.companyId, expectedVersion, {
      name: p.name,
      isActive: p.isActive,
    });
  }

  /** Idempotent seed of standard cost centres — ON CONFLICT (company_id, code) DO NOTHING. */
  async seedIfAbsent(rows: { id: string; companyId: string; code: string; name: string }[]): Promise<void> {
    for (const r of rows) {
      await getManager(this.dataSource).query(
        `INSERT INTO cost_centre (id, company_id, code, name, is_active) VALUES ($1,$2,$3,$4,true)
         ON CONFLICT (company_id, code) DO NOTHING`,
        [r.id, r.companyId, r.code, r.name],
      );
    }
  }
}
