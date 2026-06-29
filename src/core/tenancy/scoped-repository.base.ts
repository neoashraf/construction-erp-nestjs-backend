/**
 * ScopedRepository — the tenancy-safe repository base (ADR-0002 F3, skill §10, NFR-005).
 * INFRASTRUCTURE (imports TypeORM). Every read/write is scoped by `company_id` (and
 * `financial_year_id` for year-bound data) BY DEFAULT, so a forgotten filter can't leak across
 * tenants. Subclasses pass their ORM entity + whether it is year-bound; they never hand-write the
 * company filter. Repositories obtained via `getManager()` automatically enrol in the active
 * UnitOfWork transaction.
 */
import {
  DataSource,
  EntityTarget,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
} from 'typeorm';
import { TenantScopeMissingError } from '../../common/errors/domain-error';
import { getManager } from '../../infrastructure/unit-of-work/transaction-context';
import { TenantContext } from './tenant-context';

export abstract class ScopedRepository<Entity extends ObjectLiteral> {
  protected constructor(
    private readonly dataSource: DataSource,
    private readonly target: EntityTarget<Entity>,
    /** When true, queries also require + filter `financialYearId` (vouchers, journal entries, …). */
    private readonly yearBound: boolean = false,
  ) {}

  /** The TypeORM repository bound to the active transaction (or the default manager outside one). */
  protected repo(): Repository<Entity> {
    return getManager(this.dataSource).getRepository(this.target);
  }

  /**
   * Merge the mandatory tenant filter into `extra`. Throws if the required scope is absent — a
   * missing `companyId` is treated as a bug, never a silent unscoped query.
   */
  protected scopedWhere(
    tenant: TenantContext,
    extra: FindOptionsWhere<Entity> = {} as FindOptionsWhere<Entity>,
  ): FindOptionsWhere<Entity> {
    if (!tenant.companyId) {
      throw new TenantScopeMissingError('companyId is required for every scoped query');
    }
    const scope: Record<string, unknown> = { companyId: tenant.companyId };
    if (this.yearBound) {
      if (!tenant.financialYearId) {
        throw new TenantScopeMissingError('financialYearId is required for year-bound data');
      }
      scope.financialYearId = tenant.financialYearId;
    }
    return { ...extra, ...scope } as FindOptionsWhere<Entity>;
  }

  /** Scoped `find`. */
  findScoped(
    tenant: TenantContext,
    where: FindOptionsWhere<Entity> = {} as FindOptionsWhere<Entity>,
    options: Omit<FindManyOptions<Entity>, 'where'> = {},
  ): Promise<Entity[]> {
    return this.repo().find({ ...options, where: this.scopedWhere(tenant, where) });
  }

  /** Scoped `findOne`. */
  findOneScoped(
    tenant: TenantContext,
    where: FindOptionsWhere<Entity> = {} as FindOptionsWhere<Entity>,
    options: Omit<FindOneOptions<Entity>, 'where'> = {},
  ): Promise<Entity | null> {
    return this.repo().findOne({ ...options, where: this.scopedWhere(tenant, where) });
  }

  /** Scoped `count`. */
  countScoped(
    tenant: TenantContext,
    where: FindOptionsWhere<Entity> = {} as FindOptionsWhere<Entity>,
  ): Promise<number> {
    return this.repo().count({ where: this.scopedWhere(tenant, where) });
  }
}
