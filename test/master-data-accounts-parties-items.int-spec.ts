/**
 * MAS reference masters integration — Testcontainers Postgres, real migrations + constraints (skill §13).
 * Proves what can't be faked for Chart of Accounts, Parties and Items:
 *   - the idempotent construction CoA seed (runs on company create; re-running inserts nothing) — FR-MAS-018/019;
 *   - account type == group type enforced (ACCOUNT_TYPE_MISMATCH); duplicate code rejected (DUPLICATE_CODE);
 *   - cross-company account-group reference rejected (CROSS_COMPANY_REFERENCE);
 *   - party multi-role requirement (FR-MAS-022) + role-filtered list (FR-MAS-024);
 *   - item cross-company default account rejected; base_uom immutable after a UoM conversion (BASE_UOM_IMMUTABLE);
 *   - UoM conversion upsert collapses to one row; factor <= 0 rejected;
 *   - deactivate→reactivate restores is_active; ON DELETE RESTRICT; optimistic-lock conflict.
 *
 * NOTE: account-type-immutable-after-postings (FR-MAS-021) is proven at the use-case level
 * (account-use-cases.spec) via the LED has-postings seam — `journal_line` is out of this spec's schema.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { CostCentreOrmEntity } from '../src/modules/master-data/cost-centre/infrastructure/cost-centre.orm-entity';
import { AccountGroupOrmEntity } from '../src/modules/master-data/chart-of-accounts/infrastructure/account-group.orm-entity';
import { AccountOrmEntity } from '../src/modules/master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { PartyOrmEntity } from '../src/modules/master-data/party/infrastructure/party.orm-entity';
import { ItemOrmEntity } from '../src/modules/master-data/item/infrastructure/item.orm-entity';
import { ItemUomConversionOrmEntity } from '../src/modules/master-data/item/infrastructure/item-uom-conversion.orm-entity';
import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { NoopAuditService } from '../src/core/audit/infrastructure/noop-audit.service';
import { NoopAuditService as MasNoopAudit } from '../src/modules/master-data/infrastructure/noop-audit.service';
import { TypeOrmCompanyRepository } from '../src/modules/master-data/company/infrastructure/persistence/typeorm-company.repository';
import { CreateCompanyUseCase } from '../src/modules/master-data/application/company/create-company.use-case';
import { TypeOrmCostCentreRepository } from '../src/modules/master-data/cost-centre/infrastructure/typeorm-cost-centre.repository';
import { SeedStandardCostCentresUseCase } from '../src/modules/master-data/cost-centre/application/cost-centre.use-cases';
import { TypeOrmAccountGroupRepository } from '../src/modules/master-data/chart-of-accounts/infrastructure/typeorm-account-group.repository';
import { TypeOrmAccountRepository } from '../src/modules/master-data/chart-of-accounts/infrastructure/typeorm-account.repository';
import { SeedConstructionCoaUseCase, STANDARD_ACCOUNT_GROUPS, STANDARD_ACCOUNTS } from '../src/modules/master-data/chart-of-accounts/application/construction-coa.seed';
import { CreateAccountGroupUseCase } from '../src/modules/master-data/chart-of-accounts/application/account-group.use-cases';
import { CreateAccountUseCase, UpdateAccountUseCase, DeactivateAccountUseCase, ReactivateAccountUseCase } from '../src/modules/master-data/chart-of-accounts/application/account.use-cases';
import { TypeOrmPartyRepository } from '../src/modules/master-data/party/infrastructure/typeorm-party.repository';
import { CreatePartyUseCase } from '../src/modules/master-data/party/application/party.use-cases';
import { PartyQueryService } from '../src/modules/master-data/party/read/party.query-service';
import { TypeOrmItemRepository } from '../src/modules/master-data/item/infrastructure/typeorm-item.repository';
import { TypeOrmItemUomConversionRepository } from '../src/modules/master-data/item/infrastructure/typeorm-item-uom-conversion.repository';
import { CreateItemUseCase, UpdateItemUseCase, DeactivateItemUseCase, ReactivateItemUseCase, UpsertItemUomConversionUseCase } from '../src/modules/master-data/item/application/item.use-cases';
import {
  AccountTypeMismatchError,
  BaseUomImmutableError,
  CrossCompanyReferenceError,
  DuplicateCodeError,
  OptimisticLockConflictError,
  ValidationError,
} from '../src/common/errors/domain-error';
import { Actor } from '../src/core/tenancy/tenant-context';

jest.setTimeout(180_000);
const noLedger = { hasPostings: () => Promise.resolve(false) };

describe('MAS reference masters — accounts / parties / items (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let actor: Actor;
  let coaSeed: SeedConstructionCoaUseCase;
  let createGroup: CreateAccountGroupUseCase;
  let createAccount: CreateAccountUseCase;
  let updateAccount: UpdateAccountUseCase;
  let deactivateAccount: DeactivateAccountUseCase;
  let reactivateAccount: ReactivateAccountUseCase;
  let createParty: CreatePartyUseCase;
  let partyQuery: PartyQueryService;
  let createItem: CreateItemUseCase;
  let updateItem: UpdateItemUseCase;
  let upsertConversion: UpsertItemUomConversionUseCase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      synchronize: false,
      entities: [CompanyOrmEntity, FinancialYearOrmEntity, CostCentreOrmEntity, AccountGroupOrmEntity, AccountOrmEntity, PartyOrmEntity, ItemOrmEntity, ItemUomConversionOrmEntity],
      migrations: [InitialBaseline1700000000000, CreateCompanyFinancialYear1700000100000, CreateMasterDataDimensions1700000500000, CreateMasterDataAccountsPartiesItems1700000600000],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    const uow = new TypeOrmUnitOfWork(dataSource);
    const ids = new UuidIdGenerator();
    const audit = new NoopAuditService();
    const groupRepo = new TypeOrmAccountGroupRepository(dataSource);
    const accountRepo = new TypeOrmAccountRepository(dataSource);
    coaSeed = new SeedConstructionCoaUseCase(groupRepo, accountRepo, ids);

    const createCompany = new CreateCompanyUseCase(
      new TypeOrmCompanyRepository(dataSource),
      new MasNoopAudit(),
      uow,
      ids,
      new SeedStandardCostCentresUseCase(new TypeOrmCostCentreRepository(dataSource), ids),
      coaSeed,
    );

    createGroup = new CreateAccountGroupUseCase(groupRepo, audit, uow, ids);
    createAccount = new CreateAccountUseCase(accountRepo, groupRepo, audit, uow, ids);
    updateAccount = new UpdateAccountUseCase(accountRepo, groupRepo, noLedger, audit, uow);
    deactivateAccount = new DeactivateAccountUseCase(accountRepo, audit, uow);
    reactivateAccount = new ReactivateAccountUseCase(accountRepo, audit, uow);
    createParty = new CreatePartyUseCase(new TypeOrmPartyRepository(dataSource), audit, uow, ids);
    partyQuery = new PartyQueryService(dataSource);
    const itemRepo = new TypeOrmItemRepository(dataSource);
    const convRepo = new TypeOrmItemUomConversionRepository(dataSource);
    createItem = new CreateItemUseCase(itemRepo, accountRepo, audit, uow, ids);
    updateItem = new UpdateItemUseCase(itemRepo, accountRepo, audit, uow);
    upsertConversion = new UpsertItemUomConversionUseCase(itemRepo, convRepo, audit, uow, ids);
    // unused locally but constructed to prove wiring compiles
    void new DeactivateItemUseCase(itemRepo, audit, uow);
    void new ReactivateItemUseCase(itemRepo, audit, uow);

    const { id } = await createCompany.execute(
      { name: 'ZE', legalName: 'ZE Ltd', bin: '1234567890123', tin: '123456789012' },
      { userId: '00000000-0000-0000-0000-0000000000a1', companyId: 'bootstrap', financialYearId: '', role: 'Admin' },
    );
    actor = { userId: '00000000-0000-0000-0000-0000000000a1', companyId: id, financialYearId: '', role: 'Admin' };
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  const firstAccountId = async (code: string): Promise<string> => {
    const [r] = await dataSource.query(`SELECT id FROM account WHERE company_id=$1 AND code=$2`, [actor.companyId, code]);
    return r.id;
  };

  it('seeds the standard construction CoA on company create and is idempotent (FR-MAS-018/019)', async () => {
    const [{ g }] = await dataSource.query(`SELECT count(*)::int AS g FROM account_group WHERE company_id=$1`, [actor.companyId]);
    const [{ a }] = await dataSource.query(`SELECT count(*)::int AS a FROM account WHERE company_id=$1`, [actor.companyId]);
    expect(g).toBe(STANDARD_ACCOUNT_GROUPS.length);
    expect(a).toBe(STANDARD_ACCOUNTS.length);
    // every seeded account's type equals its group's type (FR-MAS-019)
    const [{ mism }] = await dataSource.query(
      `SELECT count(*)::int AS mism FROM account x JOIN account_group gr ON gr.id=x.account_group_id WHERE x.company_id=$1 AND x.type<>gr.type`,
      [actor.companyId],
    );
    expect(mism).toBe(0);
    // re-run → inserts nothing new
    await coaSeed.execute(actor.companyId);
    const [{ g2 }] = await dataSource.query(`SELECT count(*)::int AS g2 FROM account_group WHERE company_id=$1`, [actor.companyId]);
    const [{ a2 }] = await dataSource.query(`SELECT count(*)::int AS a2 FROM account WHERE company_id=$1`, [actor.companyId]);
    expect(g2).toBe(STANDARD_ACCOUNT_GROUPS.length);
    expect(a2).toBe(STANDARD_ACCOUNTS.length);
  });

  it('rejects a duplicate account code and a type mismatch (FR-MAS-018/019)', async () => {
    const { id: groupId } = await createGroup.execute({ name: 'Custom Assets', type: 'ASSET' }, actor);
    await createAccount.execute({ code: '9100', name: 'Custom Cash', accountGroupId: groupId, type: 'ASSET' }, actor);
    await expect(createAccount.execute({ code: '9100', name: 'Dup', accountGroupId: groupId, type: 'ASSET' }, actor)).rejects.toBeInstanceOf(DuplicateCodeError);
    await expect(createAccount.execute({ code: '9200', name: 'Wrong', accountGroupId: groupId, type: 'INCOME' }, actor)).rejects.toBeInstanceOf(AccountTypeMismatchError);
  });

  it('rejects an account group / default account from another company (FR-MAS-028)', async () => {
    const otherGroup = '00000000-0000-0000-0000-0000000000ff';
    await expect(createAccount.execute({ code: '9300', name: 'X', accountGroupId: otherGroup, type: 'ASSET' }, actor)).rejects.toBeInstanceOf(CrossCompanyReferenceError);
  });

  it('deactivates then reactivates an account, and rejects a stale version (FR-MAS-029/032/033)', async () => {
    const { id: groupId } = await createGroup.execute({ name: 'Toggle Group', type: 'ASSET' }, actor);
    const { id } = await createAccount.execute({ code: '9400', name: 'Toggle', accountGroupId: groupId, type: 'ASSET' }, actor);
    await deactivateAccount.execute(id, 1, actor);
    let [row] = await dataSource.query(`SELECT is_active, version FROM account WHERE id=$1`, [id]);
    expect(row.is_active).toBe(false);
    await reactivateAccount.execute(id, row.version, actor);
    [row] = await dataSource.query(`SELECT is_active FROM account WHERE id=$1`, [id]);
    expect(row.is_active).toBe(true);
    await expect(updateAccount.execute(id, { name: 'Stale' }, 1, actor)).rejects.toBeInstanceOf(OptimisticLockConflictError);
  });

  it('requires at least one party role and exposes role-filtered lists (FR-MAS-022/024)', async () => {
    await expect(
      createParty.execute({ name: 'NoRole', phone: '+8801712345678' }, actor),
    ).rejects.toBeInstanceOf(ValidationError);
    await createParty.execute({ name: 'Buyer Co', isCustomer: true, phone: '+8801712345601' }, actor);
    await createParty.execute({ name: 'Supplier Co', isSupplier: true, phone: '+8801712345602' }, actor);
    const customers = await partyQuery.list({ isCustomer: true }, actor);
    const suppliers = await partyQuery.list({ isSupplier: true }, actor);
    expect(customers.items.every((p) => p.isCustomer)).toBe(true);
    expect(customers.items.some((p) => p.name === 'Buyer Co')).toBe(true);
    expect(suppliers.items.some((p) => p.name === 'Supplier Co')).toBe(true);
    expect(suppliers.items.some((p) => p.name === 'Buyer Co')).toBe(false);
  });

  it('creates items, rejects a cross-company default account, and upserts UoM conversions (FR-MAS-025/026/027)', async () => {
    const acctId = await firstAccountId('5100'); // Material Expense
    await expect(
      createItem.execute({ code: 'CEM-50', name: 'Cement', baseUom: 'BAG', defaultAccountId: '00000000-0000-0000-0000-0000000000ff' }, actor),
    ).rejects.toBeInstanceOf(CrossCompanyReferenceError);

    const { id: itemId } = await createItem.execute({ code: 'CEM-50', name: 'Cement', baseUom: 'BAG', hsCode: '2523.29', defaultAccountId: acctId }, actor);
    await expect(createItem.execute({ code: 'CEM-50', name: 'Dup', baseUom: 'BAG', defaultAccountId: acctId }, actor)).rejects.toBeInstanceOf(DuplicateCodeError);

    const r1 = await upsertConversion.execute(itemId, { uom: 'TON', factorToBase: '1000' }, actor);
    await upsertConversion.execute(itemId, { uom: 'TON', factorToBase: '1200' }, actor); // collapses
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM item_uom_conversion WHERE item_id=$1`, [itemId]);
    expect(n).toBe(1);
    const [conv] = await dataSource.query(`SELECT factor_to_base::text AS f FROM item_uom_conversion WHERE id=$1`, [r1.id]);
    expect(conv.f).toBe('1200.0000');
    await expect(upsertConversion.execute(itemId, { uom: 'KG', factorToBase: '0' }, actor)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a base_uom change once a UoM conversion exists (BASE_UOM_IMMUTABLE, FR-MAS-034)', async () => {
    const acctId = await firstAccountId('5100');
    const { id: itemId } = await createItem.execute({ code: 'STEEL', name: 'Steel Rod', baseUom: 'PCS', defaultAccountId: acctId }, actor);
    // editable while no conversions exist
    await updateItem.execute(itemId, { baseUom: 'ROD' }, 1, actor);
    let [row] = await dataSource.query(`SELECT base_uom, version FROM item WHERE id=$1`, [itemId]);
    expect(row.base_uom).toBe('ROD');
    // once a conversion exists, base_uom is immutable
    await upsertConversion.execute(itemId, { uom: 'BUNDLE', factorToBase: '10' }, actor);
    [row] = await dataSource.query(`SELECT version FROM item WHERE id=$1`, [itemId]);
    await expect(updateItem.execute(itemId, { baseUom: 'PCS' }, row.version, actor)).rejects.toBeInstanceOf(BaseUomImmutableError);
  });

  it('protects referenced masters with ON DELETE RESTRICT (FR-MAS-030)', async () => {
    const acctId = await firstAccountId('5100');
    await createItem.execute({ code: 'PAINT', name: 'Paint', baseUom: 'LITRE', defaultAccountId: acctId }, actor);
    // account referenced by an item cannot be hard-deleted
    await expect(dataSource.query(`DELETE FROM account WHERE id=$1`, [acctId])).rejects.toThrow();
    // a group referenced by an account cannot be hard-deleted
    const [grp] = await dataSource.query(`SELECT account_group_id FROM account WHERE id=$1`, [acctId]);
    await expect(dataSource.query(`DELETE FROM account_group WHERE id=$1`, [grp.account_group_id])).rejects.toThrow();
  });
});
