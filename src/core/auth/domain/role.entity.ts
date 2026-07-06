/**
 * Role domain entity (AUD RBAC v2 — FR-AUD-011/016/019/034). PURE TypeScript; no NestJS/TypeORM.
 * `name` is a free per-company-unique string; `is_system` marks the six protected built-ins
 * (editable grants/scope/limit, but locked name and non-deletable). approval_limit = null → no
 * approval authority (every approval escalates, §10). Custom roles are `is_system=false`, full CRUD.
 */
import Decimal from 'decimal.js';

export class SystemRoleImmutableError extends Error {
  constructor() {
    super('SYSTEM_ROLE_IMMUTABLE');
    this.name = 'SystemRoleImmutableError';
  }
}

export interface RoleProps {
  companyId: string;
  name: string;
  isSystem: boolean;
  approvalLimit: Decimal | null;
  isUnscoped: boolean;
  version: number;
}

export class Role {
  private constructor(
    readonly id: string,
    private _props: RoleProps,
  ) {}

  get props(): Readonly<RoleProps> {
    return this._props;
  }

  /** Create a custom role (is_system=false). */
  static create(id: string, props: Omit<RoleProps, 'version' | 'isSystem'>): Role {
    if (props.approvalLimit !== null && props.approvalLimit.isNegative()) {
      throw new Error('approvalLimit must be >= 0');
    }
    if (!props.name || props.name.trim().length === 0) {
      throw new Error('role name is required');
    }
    return new Role(id, { ...props, isSystem: false, version: 1 });
  }

  static rehydrate(id: string, props: RoleProps): Role {
    return new Role(id, { ...props });
  }

  /** Rename — custom roles only; a built-in rejects the rename (SYSTEM_ROLE_IMMUTABLE). */
  rename(name: string): { before: Partial<RoleProps>; after: Partial<RoleProps> } {
    if (this._props.isSystem) throw new SystemRoleImmutableError();
    if (!name || name.trim().length === 0) throw new Error('role name is required');
    const before = { name: this._props.name };
    this._props = { ...this._props, name };
    return { before, after: { name } };
  }

  /** Guard: a built-in role cannot be deleted. */
  assertDeletable(): void {
    if (this._props.isSystem) throw new SystemRoleImmutableError();
  }

  /** Update approval limit and/or isUnscoped (allowed for built-ins too). Returns before/after for audit. */
  patch(updates: { approvalLimit?: Decimal | null; isUnscoped?: boolean }): { before: Partial<RoleProps>; after: Partial<RoleProps> } {
    const before: Partial<RoleProps> = {};
    const after: Partial<RoleProps> = {};
    if (updates.approvalLimit !== undefined) {
      if (updates.approvalLimit !== null && updates.approvalLimit.isNegative()) {
        throw new Error('approvalLimit must be >= 0');
      }
      before.approvalLimit = this._props.approvalLimit;
      after.approvalLimit = updates.approvalLimit;
      this._props = { ...this._props, approvalLimit: updates.approvalLimit };
    }
    if (updates.isUnscoped !== undefined) {
      before.isUnscoped = this._props.isUnscoped;
      after.isUnscoped = updates.isUnscoped;
      this._props = { ...this._props, isUnscoped: updates.isUnscoped };
    }
    return { before, after };
  }
}
