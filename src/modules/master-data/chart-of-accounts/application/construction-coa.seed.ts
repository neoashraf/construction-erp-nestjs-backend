/**
 * Standard construction Chart of Accounts seed (FR-MAS-018/019, design §8). Idempotent: groups dedupe
 * by (company, name) and accounts by (company, code), so re-running inserts nothing new. The set
 * supplies the control/posting accounts LED and the transaction modules reference (A/R, A/P,
 * retention, advance, VAT/TDS/AIT, revenue, material/labour expense, payables). Each account's `type`
 * equals its group's `type` (FR-MAS-019).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { AccountType } from '../domain/account-type';
import { AccountGroup } from '../domain/account-group';
import { Account } from '../domain/account';
import { TypeOrmAccountGroupRepository } from '../infrastructure/typeorm-account-group.repository';
import { TypeOrmAccountRepository } from '../infrastructure/typeorm-account.repository';

interface SeedGroup {
  name: string;
  type: AccountType;
  parent?: string;
}
interface SeedAccount {
  code: string;
  name: string;
  group: string;
  type: AccountType;
}

/** Parent groups MUST precede their children (the seeder resolves parents by name as it goes). */
export const STANDARD_ACCOUNT_GROUPS: SeedGroup[] = [
  { name: 'Assets', type: 'ASSET' },
  { name: 'Current Assets', type: 'ASSET', parent: 'Assets' },
  { name: 'Fixed Assets', type: 'ASSET', parent: 'Assets' },
  { name: 'Liabilities', type: 'LIABILITY' },
  { name: 'Current Liabilities', type: 'LIABILITY', parent: 'Liabilities' },
  { name: 'Equity', type: 'EQUITY' },
  { name: 'Income', type: 'INCOME' },
  { name: 'Expenses', type: 'EXPENSE' },
  { name: 'Direct Costs', type: 'EXPENSE', parent: 'Expenses' },
  { name: 'Overheads', type: 'EXPENSE', parent: 'Expenses' },
];

export const STANDARD_ACCOUNTS: SeedAccount[] = [
  { code: '1100', name: 'Cash in Hand', group: 'Current Assets', type: 'ASSET' },
  { code: '1110', name: 'Bank Account', group: 'Current Assets', type: 'ASSET' },
  { code: '1200', name: 'Accounts Receivable', group: 'Current Assets', type: 'ASSET' },
  { code: '1210', name: 'Retention Receivable', group: 'Current Assets', type: 'ASSET' },
  { code: '1220', name: 'TDS Recoverable', group: 'Current Assets', type: 'ASSET' },
  { code: '1230', name: 'VAT Input (Recoverable)', group: 'Current Assets', type: 'ASSET' },
  { code: '1300', name: 'Inventory', group: 'Current Assets', type: 'ASSET' },
  { code: '1500', name: 'Plant & Machinery', group: 'Fixed Assets', type: 'ASSET' },
  { code: '2100', name: 'Accounts Payable', group: 'Current Liabilities', type: 'LIABILITY' },
  { code: '2110', name: 'Mobilization Advance', group: 'Current Liabilities', type: 'LIABILITY' },
  { code: '2200', name: 'VAT Payable', group: 'Current Liabilities', type: 'LIABILITY' },
  { code: '2210', name: 'TDS Payable', group: 'Current Liabilities', type: 'LIABILITY' },
  { code: '2220', name: 'AIT Payable', group: 'Current Liabilities', type: 'LIABILITY' },
  { code: '2300', name: 'Salary Payable', group: 'Current Liabilities', type: 'LIABILITY' },
  { code: '2310', name: 'Daily-Labour Payable', group: 'Current Liabilities', type: 'LIABILITY' },
  { code: '3100', name: 'Share Capital', group: 'Equity', type: 'EQUITY' },
  { code: '3200', name: 'Retained Earnings', group: 'Equity', type: 'EQUITY' },
  { code: '4100', name: 'Contract Revenue', group: 'Income', type: 'INCOME' },
  { code: '5100', name: 'Material Expense', group: 'Direct Costs', type: 'EXPENSE' },
  { code: '5110', name: 'Labour Expense', group: 'Direct Costs', type: 'EXPENSE' },
  { code: '5120', name: 'Sub-contractor Expense', group: 'Direct Costs', type: 'EXPENSE' },
  { code: '6100', name: 'Salary Expense', group: 'Overheads', type: 'EXPENSE' },
  { code: '6200', name: 'Bank Charges', group: 'Overheads', type: 'EXPENSE' },
  { code: '6300', name: 'General Overheads', group: 'Overheads', type: 'EXPENSE' },
];

@Injectable()
export class SeedConstructionCoaUseCase {
  constructor(
    private readonly groups: TypeOrmAccountGroupRepository,
    private readonly accounts: TypeOrmAccountRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /** Idempotent — re-running inserts nothing new. Call inside the caller's UoW (atomic with company create). */
  async execute(companyId: string): Promise<void> {
    const nameToId = await this.groups.namesToIds(companyId);
    for (const g of STANDARD_ACCOUNT_GROUPS) {
      if (nameToId.has(g.name)) continue;
      const id = this.ids.next();
      const parentId = g.parent ? (nameToId.get(g.parent) ?? null) : null;
      await this.groups.seedIfAbsent(
        AccountGroup.seed(id, { companyId, name: g.name, parentGroupId: parentId, type: g.type }),
      );
      nameToId.set(g.name, id);
    }

    const existingCodes = await this.accounts.existingCodes(companyId);
    for (const a of STANDARD_ACCOUNTS) {
      if (existingCodes.has(a.code)) continue;
      const groupId = nameToId.get(a.group);
      if (!groupId) continue; // defensive: group always seeded above
      await this.accounts.seedIfAbsent(
        Account.seed(this.ids.next(), { companyId, code: a.code, name: a.name, accountGroupId: groupId, type: a.type }),
      );
    }
  }
}
