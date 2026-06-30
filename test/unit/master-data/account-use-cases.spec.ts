/**
 * Account use-case tests with in-memory fakes (no DB) — the guards that need orchestration:
 *   - type must equal the group's type on create (ACCOUNT_TYPE_MISMATCH, FR-MAS-019);
 *   - cross-company group reference rejected (CROSS_COMPANY_REFERENCE, FR-MAS-028);
 *   - type immutable once the account has ledger postings (ACCOUNT_TYPE_IMMUTABLE, FR-MAS-021),
 *     via the LED has-postings seam.
 */
import { CreateAccountUseCase, UpdateAccountUseCase } from '../../../src/modules/master-data/chart-of-accounts/application/account.use-cases';
import { Account } from '../../../src/modules/master-data/chart-of-accounts/domain/account';
import { AccountType } from '../../../src/modules/master-data/chart-of-accounts/domain/account-type';
import { TypeOrmAccountRepository } from '../../../src/modules/master-data/chart-of-accounts/infrastructure/typeorm-account.repository';
import { TypeOrmAccountGroupRepository } from '../../../src/modules/master-data/chart-of-accounts/infrastructure/typeorm-account-group.repository';
import { LedgerPostingsQuery } from '../../../src/modules/master-data/chart-of-accounts/domain/ports/ledger-postings.port';
import {
  AccountTypeImmutableError,
  AccountTypeMismatchError,
  CrossCompanyReferenceError,
} from '../../../src/common/errors/domain-error';
import { AuditEntry, AuditService } from '../../../src/core/audit/application/audit.port';
import { UnitOfWork } from '../../../src/common/ports/unit-of-work.port';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const passthroughUow: UnitOfWork = { run: (work) => work() };
const ids: IdGenerator = { next: () => 'acc-1' };
const actor: Actor = { userId: 'u-1', companyId: 'co-1', financialYearId: '', role: 'Admin', isUnscoped: true, assignedProjectIds: [], approvalLimit: null };

class FakeAudit implements AuditService {
  entries: AuditEntry[] = [];
  record(e: AuditEntry): Promise<void> {
    this.entries.push(e);
    return Promise.resolve();
  }
}

/** Group repo stub: only `typeOf` is exercised; returns the configured (companyId-aware) type. */
function groupRepo(typeByCompany: (id: string, companyId: string) => AccountType | null): TypeOrmAccountGroupRepository {
  return { typeOf: (id: string, companyId: string) => Promise.resolve(typeByCompany(id, companyId)) } as unknown as TypeOrmAccountGroupRepository;
}

class FakeAccountRepo {
  store = new Map<string, Account>();
  findById(id: string): Promise<Account | null> {
    const a = this.store.get(id);
    return Promise.resolve(a ? Account.rehydrate(a.id, { ...a.props }) : null);
  }
  insert(a: Account): Promise<void> {
    this.store.set(a.id, a);
    return Promise.resolve();
  }
  update(a: Account): Promise<void> {
    this.store.set(a.id, a);
    return Promise.resolve();
  }
}

const ledger = (has: boolean): LedgerPostingsQuery => ({ hasPostings: () => Promise.resolve(has) });

describe('Account use cases', () => {
  it('creates when type matches the group type (FR-MAS-019)', async () => {
    const repo = new FakeAccountRepo();
    const uc = new CreateAccountUseCase(repo as unknown as TypeOrmAccountRepository, groupRepo(() => 'ASSET'), new FakeAudit(), passthroughUow, ids);
    const { id } = await uc.execute({ code: '1100', name: 'Cash', accountGroupId: 'g-1', type: 'ASSET' }, actor);
    expect(repo.store.get(id)?.props.type).toBe('ASSET');
  });

  it('rejects a type that differs from the group type (ACCOUNT_TYPE_MISMATCH)', async () => {
    const uc = new CreateAccountUseCase(new FakeAccountRepo() as unknown as TypeOrmAccountRepository, groupRepo(() => 'ASSET'), new FakeAudit(), passthroughUow, ids);
    await expect(
      uc.execute({ code: '4100', name: 'Revenue', accountGroupId: 'g-1', type: 'INCOME' }, actor),
    ).rejects.toBeInstanceOf(AccountTypeMismatchError);
  });

  it('rejects a group from another company (CROSS_COMPANY_REFERENCE)', async () => {
    const uc = new CreateAccountUseCase(new FakeAccountRepo() as unknown as TypeOrmAccountRepository, groupRepo(() => null), new FakeAudit(), passthroughUow, ids);
    await expect(
      uc.execute({ code: '1100', name: 'Cash', accountGroupId: 'g-x', type: 'ASSET' }, actor),
    ).rejects.toBeInstanceOf(CrossCompanyReferenceError);
  });

  it('rejects a type change once the account has postings (ACCOUNT_TYPE_IMMUTABLE, FR-MAS-021)', async () => {
    const repo = new FakeAccountRepo();
    repo.store.set('acc-1', Account.seed('acc-1', { companyId: 'co-1', code: '1100', name: 'Cash', accountGroupId: 'g-1', type: 'ASSET' }));
    const uc = new UpdateAccountUseCase(repo as unknown as TypeOrmAccountRepository, groupRepo(() => 'EXPENSE'), ledger(true), new FakeAudit(), passthroughUow);
    await expect(uc.execute('acc-1', { type: 'EXPENSE' }, 1, actor)).rejects.toBeInstanceOf(AccountTypeImmutableError);
    expect(repo.store.get('acc-1')?.props.type).toBe('ASSET'); // unchanged
  });

  it('allows a type change when there are no postings and the new group type matches', async () => {
    const repo = new FakeAccountRepo();
    repo.store.set('acc-1', Account.seed('acc-1', { companyId: 'co-1', code: '1100', name: 'Cash', accountGroupId: 'g-1', type: 'ASSET' }));
    const uc = new UpdateAccountUseCase(repo as unknown as TypeOrmAccountRepository, groupRepo(() => 'EXPENSE'), ledger(false), new FakeAudit(), passthroughUow);
    await uc.execute('acc-1', { type: 'EXPENSE' }, 1, actor);
    expect(repo.store.get('acc-1')?.props.type).toBe('EXPENSE');
  });
});
