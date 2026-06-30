/**
 * Role domain entity (AUD RBAC — FR-AUD-011/016/019). PURE TypeScript; no NestJS/TypeORM.
 * The six platform roles are fixed enums; Phase 1 does not create custom roles.
 * approval_limit = null → no approval authority (every approval escalates, §10).
 */
import Decimal from 'decimal.js';
import { RoleName } from './role';

export interface RoleProps {
  companyId: string;
  name: RoleName;
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

  static rehydrate(id: string, props: RoleProps): Role {
    return new Role(id, { ...props });
  }

  /** Update approval limit and/or isUnscoped. Returns before/after for audit. */
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
