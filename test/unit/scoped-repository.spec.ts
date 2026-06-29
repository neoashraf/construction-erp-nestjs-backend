import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { ScopedRepository } from '../../src/core/tenancy/scoped-repository.base';
import { TenantContext } from '../../src/core/tenancy/tenant-context';
import { TenantScopeMissingError } from '../../src/common/errors/domain-error';

interface DemoRow extends ObjectLiteral {
  id: string;
  companyId: string;
  financialYearId: string;
  name: string;
}

/**
 * A test double over a real ScopedRepository: `repo()` is overridden to return a stub repository that
 * records the options it was called with, so we can assert the tenant filter was injected — no DB.
 */
class StubScopedRepository extends ScopedRepository<DemoRow> {
  lastFindOptions: unknown;

  constructor(yearBound: boolean) {
    // dataSource/target are unused because repo() is overridden below.
    super({} as DataSource, 'demo' as unknown as never, yearBound);
  }

  protected override repo(): Repository<DemoRow> {
    return {
      find: (options: unknown) => {
        this.lastFindOptions = options;
        return Promise.resolve([]);
      },
      findOne: (options: unknown) => {
        this.lastFindOptions = options;
        return Promise.resolve(null);
      },
      count: (options: unknown) => {
        this.lastFindOptions = options;
        return Promise.resolve(0);
      },
    } as unknown as Repository<DemoRow>;
  }

  // expose the protected helper for direct assertion
  buildWhere(tenant: TenantContext, extra?: Record<string, unknown>) {
    return this.scopedWhere(tenant, extra as never);
  }
}

describe('ScopedRepository (tenant scoping by default)', () => {
  const tenant: TenantContext = { companyId: 'co-1', financialYearId: 'fy-2526' };

  it('injects company_id into the where clause', () => {
    const repo = new StubScopedRepository(false);
    expect(repo.buildWhere({ companyId: 'co-1' })).toEqual({ companyId: 'co-1' });
  });

  it('injects company_id AND financial_year_id for year-bound entities', () => {
    const repo = new StubScopedRepository(true);
    expect(repo.buildWhere(tenant)).toEqual({
      companyId: 'co-1',
      financialYearId: 'fy-2526',
    });
  });

  it('merges caller-supplied filters under the tenant scope', () => {
    const repo = new StubScopedRepository(false);
    expect(repo.buildWhere({ companyId: 'co-1' }, { name: 'Acme' })).toEqual({
      name: 'Acme',
      companyId: 'co-1',
    });
  });

  it('the tenant scope cannot be overridden by caller filters', () => {
    const repo = new StubScopedRepository(false);
    // a malicious/buggy extra trying to widen scope is overwritten by the real companyId
    const where = repo.buildWhere({ companyId: 'co-1' }, { companyId: 'other-co' });
    expect(where).toEqual({ companyId: 'co-1' });
  });

  it('throws when companyId is missing (no silent unscoped query)', () => {
    const repo = new StubScopedRepository(false);
    expect(() => repo.buildWhere({ companyId: '' })).toThrow(TenantScopeMissingError);
  });

  it('throws when a year-bound entity lacks financialYearId', () => {
    const repo = new StubScopedRepository(true);
    expect(() => repo.buildWhere({ companyId: 'co-1' })).toThrow(TenantScopeMissingError);
  });

  it('findScoped passes the scoped where to the underlying repository', async () => {
    const repo = new StubScopedRepository(false);
    await repo.findScoped({ companyId: 'co-1' }, { name: 'Acme' } as never);
    expect(repo.lastFindOptions).toEqual({ where: { name: 'Acme', companyId: 'co-1' } });
  });
});
