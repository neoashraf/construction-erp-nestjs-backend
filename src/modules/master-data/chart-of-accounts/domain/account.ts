/**
 * Account (ChartOfAccount) master (MAS, FR-MAS-018/019/020/021/029/033) — PURE domain. Typed,
 * company-unique `code`, under an AccountGroup. `openingBalance` is a nullable reference field only —
 * MAS NEVER posts it (the GEN opening journal realises it). The `type == group.type` and
 * `type`-immutable-after-postings rules need a group lookup / LED query, so they are enforced in the
 * use case; the aggregate exposes the mutators.
 */
import Decimal from 'decimal.js';
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { IdGenerator } from '../../../../common/ports/id-generator.port';
import { AccountType, assertAccountType } from './account-type';

export interface AccountProps {
  companyId: string;
  code: string;
  name: string;
  accountGroupId: string;
  type: AccountType;
  openingBalance: Decimal | null;
  isActive: boolean;
  version: number;
}

export class Account extends Entity<string> {
  private constructor(
    id: string,
    private _props: AccountProps,
  ) {
    super(id);
  }

  static create(
    input: {
      companyId: string;
      code: string;
      name: string;
      accountGroupId: string;
      type: string;
      openingBalance?: string | number | null;
    },
    ids: IdGenerator,
  ): Account {
    return new Account(ids.next(), {
      companyId: input.companyId,
      code: req(input.code, 'code'),
      name: req(input.name, 'name'),
      accountGroupId: req(input.accountGroupId, 'accountGroupId'),
      type: assertAccountType(input.type),
      openingBalance: money(input.openingBalance),
      isActive: true,
      version: 1,
    });
  }

  /** Construct with an explicit id (used by the idempotent construction-CoA seed). */
  static seed(
    id: string,
    input: { companyId: string; code: string; name: string; accountGroupId: string; type: AccountType },
  ): Account {
    return new Account(id, {
      companyId: input.companyId,
      code: input.code,
      name: input.name,
      accountGroupId: input.accountGroupId,
      type: input.type,
      openingBalance: null,
      isActive: true,
      version: 1,
    });
  }

  static rehydrate(id: string, props: AccountProps): Account {
    return new Account(id, props);
  }

  rename(name: string): void {
    this._props.name = req(name, 'name');
  }
  setOpeningBalance(value: string | number | null): void {
    this._props.openingBalance = money(value);
  }
  reassignGroup(accountGroupId: string): void {
    this._props.accountGroupId = req(accountGroupId, 'accountGroupId');
  }
  /** Change the account's classification. Immutability-after-postings is gated by the use case. */
  changeType(type: string): void {
    this._props.type = assertAccountType(type);
  }
  deactivate(): void {
    this._props.isActive = false;
  }
  reactivate(): void {
    this._props.isActive = true;
  }

  get props(): Readonly<AccountProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}

function money(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Decimal(value);
  if (!d.isFinite()) throw new ValidationError('openingBalance must be a finite number', { value });
  return d;
}
