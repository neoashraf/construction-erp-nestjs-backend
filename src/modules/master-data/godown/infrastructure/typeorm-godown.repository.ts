/** TypeOrmGodownRepository (INFRASTRUCTURE) — project-scoped name uniqueness; version-guarded. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DuplicateNameError } from '../../../../common/errors/domain-error';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { isUniqueViolation, versionedUpdate } from '../../shared/repo-helpers';
import { Godown } from '../domain/godown';
import { GodownOrmEntity } from './godown.orm-entity';

@Injectable()
export class TypeOrmGodownRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(GodownOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<Godown | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }

  async insert(g: Godown): Promise<void> {
    const p = g.props;
    try {
      await this.repo().insert({ id: g.id, companyId: p.companyId, projectId: p.projectId, name: p.name, location: p.location, isActive: p.isActive });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateNameError(p.name, { projectId: p.projectId });
      throw err;
    }
  }

  async update(g: Godown, expectedVersion: number): Promise<void> {
    const p = g.props;
    try {
      await versionedUpdate(this.repo(), GodownOrmEntity, g.id, p.companyId, expectedVersion, {
        name: p.name,
        location: p.location,
        isActive: p.isActive,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateNameError(p.name, { projectId: p.projectId });
      throw err;
    }
  }
}

function toDomain(r: GodownOrmEntity): Godown {
  return Godown.rehydrate(r.id, { companyId: r.companyId, projectId: r.projectId, name: r.name, location: r.location, isActive: r.isActive, version: r.version });
}
