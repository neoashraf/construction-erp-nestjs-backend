/**
 * AccountGroup master (MAS, FR-MAS-017) — PURE domain. Typed, multi-level hierarchy via
 * `parentGroupId`. Company-scoped; rename + reparent. The group's `type` is fixed at creation (an
 * account under it must match — FR-MAS-019).
 */
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { IdGenerator } from '../../../../common/ports/id-generator.port';
import { AccountType, assertAccountType } from './account-type';

export interface AccountGroupProps {
  companyId: string;
  name: string;
  parentGroupId: string | null;
  type: AccountType;
  version: number;
}

export class AccountGroup extends Entity<string> {
  private constructor(
    id: string,
    private _props: AccountGroupProps,
  ) {
    super(id);
  }

  static create(
    input: { companyId: string; name: string; parentGroupId?: string | null; type: string },
    ids: IdGenerator,
  ): AccountGroup {
    return new AccountGroup(ids.next(), {
      companyId: input.companyId,
      name: req(input.name, 'name'),
      parentGroupId: input.parentGroupId ?? null,
      type: assertAccountType(input.type),
      version: 1,
    });
  }

  /** Construct with an explicit id (used by the idempotent construction-CoA seed). */
  static seed(id: string, input: { companyId: string; name: string; parentGroupId: string | null; type: AccountType }): AccountGroup {
    return new AccountGroup(id, { ...input, version: 1 });
  }

  static rehydrate(id: string, props: AccountGroupProps): AccountGroup {
    return new AccountGroup(id, props);
  }

  update(input: { name?: string; parentGroupId?: string | null }): void {
    if (input.name !== undefined) this._props.name = req(input.name, 'name');
    if (input.parentGroupId !== undefined) {
      if (input.parentGroupId === this.id) {
        throw new ValidationError('An account group cannot be its own parent', { id: this.id });
      }
      this._props.parentGroupId = input.parentGroupId;
    }
  }

  get props(): Readonly<AccountGroupProps> {
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
