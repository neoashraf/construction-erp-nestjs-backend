/** TypeOrmPurposeRepository (INFRASTRUCTURE) — project-scoped; case-insensitive name dedupe. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { isUniqueViolation, versionedUpdate } from '../../shared/repo-helpers';
import { Purpose } from '../domain/purpose';
import { PurposeOrmEntity } from './purpose.orm-entity';

@Injectable()
export class TypeOrmPurposeRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(PurposeOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<Purpose | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }

  /** Case-insensitive name match within a project (the dedupe lookup). */
  async findByNameCI(projectId: string, name: string, companyId: string): Promise<Purpose | null> {
    const r = await this.repo()
      .createQueryBuilder('p')
      .where('p.project_id = :projectId AND p.company_id = :companyId AND lower(p.name) = lower(:name)', { projectId, companyId, name })
      .getOne();
    return r ? toDomain(r) : null;
  }

  /** Insert; on the (project_id, lower(name)) unique-violation race, returns false (caller re-finds). */
  async tryInsert(p: Purpose): Promise<boolean> {
    try {
      await this.repo().insert({ id: p.id, companyId: p.props.companyId, projectId: p.props.projectId, name: p.props.name, isActive: p.props.isActive });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async update(p: Purpose, expectedVersion: number): Promise<void> {
    await versionedUpdate(this.repo(), PurposeOrmEntity, p.id, p.props.companyId, expectedVersion, {
      name: p.props.name,
      isActive: p.props.isActive,
    });
  }
}

function toDomain(r: PurposeOrmEntity): Purpose {
  return Purpose.rehydrate(r.id, { companyId: r.companyId, projectId: r.projectId, name: r.name, isActive: r.isActive, version: r.version });
}
