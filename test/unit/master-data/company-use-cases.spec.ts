/**
 * Company use-case tests with in-memory fakes (no DB) — orchestration, optimistic concurrency,
 * tenant scoping, audit (FR-MAS-001, FR-MAS-004, FR-MAS-031, FR-MAS-032).
 */
import { Company } from '../../../src/modules/master-data/company/domain/company';
import { CompanyRepository } from '../../../src/modules/master-data/company/domain/ports/company.repository';
import { CreateCompanyUseCase } from '../../../src/modules/master-data/application/company/create-company.use-case';
import { UpdateCompanyUseCase } from '../../../src/modules/master-data/application/company/update-company.use-case';
import { UpdateLocalizationUseCase } from '../../../src/modules/master-data/application/company/update-localization.use-case';
import {
  AuditEntry,
  AuditService,
} from '../../../src/modules/master-data/application/ports/audit.port';
import { NotFoundError, OptimisticLockConflictError } from '../../../src/common/errors/domain-error';
import { UnitOfWork } from '../../../src/common/ports/unit-of-work.port';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const fixedIds = (id: string): IdGenerator => ({ next: () => id });
const passthroughUow: UnitOfWork = { run: (work) => work() };

class FakeAudit implements AuditService {
  entries: AuditEntry[] = [];
  record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

/** In-memory CompanyRepository that emulates the DB version bump on update. */
class FakeCompanyRepo implements CompanyRepository {
  private store = new Map<string, Company>();
  findById(id: string): Promise<Company | null> {
    const c = this.store.get(id);
    return Promise.resolve(c ? clone(c, c.version) : null);
  }
  save(company: Company): Promise<void> {
    const exists = this.store.has(company.id);
    this.store.set(company.id, clone(company, exists ? company.version + 1 : company.version));
    return Promise.resolve();
  }
}

function clone(c: Company, version: number): Company {
  return Company.rehydrate(c.id, { ...c.props, version });
}

const VALID = {
  name: 'Zakir Enterprise',
  legalName: 'Zakir Enterprise Ltd.',
  bin: '1234567890123',
  tin: '123456789012',
};
const actor: Actor = { userId: 'u-1', companyId: 'co-1', financialYearId: '', role: 'Admin' };

describe('Company use cases', () => {
  let repo: FakeCompanyRepo;
  let audit: FakeAudit;

  beforeEach(() => {
    repo = new FakeCompanyRepo();
    audit = new FakeAudit();
  });

  // The cost-centre + construction-CoA seeds run inside company-create; stub them (own specs cover them).
  const seedStub = { execute: () => Promise.resolve() } as unknown as ConstructorParameters<typeof CreateCompanyUseCase>[4];
  const coaSeedStub = { execute: () => Promise.resolve() } as unknown as ConstructorParameters<typeof CreateCompanyUseCase>[5];
  function createUc() {
    return new CreateCompanyUseCase(repo, audit, passthroughUow, fixedIds('co-1'), seedStub, coaSeedStub);
  }

  it('creates a company at version 1 and records a CREATE audit (FR-MAS-001/031)', async () => {
    const { id } = await createUc().execute(VALID, actor);
    expect(id).toBe('co-1');
    const saved = await repo.findById('co-1');
    expect(saved?.props.version).toBe(1);
    expect(saved?.props.name).toBe('Zakir Enterprise');
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: 'CREATE', entityType: 'Company', entityId: 'co-1' });
  });

  it('patches identity under the correct version and bumps it (FR-MAS-004/032)', async () => {
    await createUc().execute(VALID, actor);
    const update = new UpdateCompanyUseCase(repo, audit, passthroughUow);
    await update.execute('co-1', { name: 'ZE Renamed' }, 1, actor);
    const saved = await repo.findById('co-1');
    expect(saved?.props.name).toBe('ZE Renamed');
    expect(saved?.props.version).toBe(2);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'UPDATE', entityType: 'Company' });
  });

  it('rejects a stale-version patch with OptimisticLockConflictError (FR-MAS-032)', async () => {
    await createUc().execute(VALID, actor);
    const update = new UpdateCompanyUseCase(repo, audit, passthroughUow);
    await update.execute('co-1', { name: 'First' }, 1, actor); // → version 2
    await expect(update.execute('co-1', { name: 'Second' }, 1, actor)).rejects.toBeInstanceOf(
      OptimisticLockConflictError,
    );
  });

  it('refuses to edit a company outside the actor scope (404, FR-MAS-001)', async () => {
    await createUc().execute(VALID, actor);
    const update = new UpdateCompanyUseCase(repo, audit, passthroughUow);
    const otherActor: Actor = { ...actor, companyId: 'other-co' };
    await expect(update.execute('co-1', { name: 'x' }, 1, otherActor)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('updates localization and bumps the version (FR-MAS-004)', async () => {
    await createUc().execute(VALID, actor);
    const loc = new UpdateLocalizationUseCase(repo, audit, passthroughUow);
    await loc.execute('co-1', { currency: 'USD', dateFormat: 'YYYY-MM-DD', locale: 'en-US' }, 1, actor);
    const saved = await repo.findById('co-1');
    expect(saved?.props.currency).toBe('USD');
    expect(saved?.props.version).toBe(2);
  });
});
