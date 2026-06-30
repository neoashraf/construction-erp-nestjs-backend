/**
 * Permission domain entity (AUD RBAC — FR-AUD-012/013/016/019). PURE TypeScript.
 * A Permission is a (role, module, action) grant with project_scope + optional value_limit.
 */
import Decimal from 'decimal.js';

export const MODULE_CODES = [
  'AUD', 'NUM', 'PER', 'LED', 'MAS',
  'SAL', 'PUR', 'REQ', 'INV', 'REC',
  'HR', 'PAY', 'GEN', 'RPT', 'DSH',
] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];

export const ACTION_CODES = [
  'CREATE', 'READ', 'UPDATE', 'DELETE',
  'POST', 'CANCEL', 'APPROVE', 'REJECT',
] as const;
export type ActionCode = (typeof ACTION_CODES)[number];

export type ProjectScope = 'ALL' | 'ASSIGNED';

export interface PermissionProps {
  roleId: string;
  companyId: string;
  module: ModuleCode;
  action: ActionCode;
  projectScope: ProjectScope;
  valueLimit: Decimal | null;
  version: number;
}

export class Permission {
  private constructor(
    readonly id: string,
    private _props: PermissionProps,
  ) {}

  get props(): Readonly<PermissionProps> {
    return this._props;
  }

  static create(id: string, props: Omit<PermissionProps, 'version'>): Permission {
    if (props.valueLimit !== null && props.valueLimit.isNegative()) {
      throw new Error('valueLimit must be >= 0');
    }
    return new Permission(id, { ...props, version: 1 });
  }

  static rehydrate(id: string, props: PermissionProps): Permission {
    return new Permission(id, { ...props });
  }

  patch(updates: { projectScope?: ProjectScope; valueLimit?: Decimal | null }): { before: Partial<PermissionProps>; after: Partial<PermissionProps> } {
    const before: Partial<PermissionProps> = {};
    const after: Partial<PermissionProps> = {};
    if (updates.projectScope !== undefined) {
      before.projectScope = this._props.projectScope;
      after.projectScope = updates.projectScope;
      this._props = { ...this._props, projectScope: updates.projectScope };
    }
    if (updates.valueLimit !== undefined) {
      if (updates.valueLimit !== null && updates.valueLimit.isNegative()) {
        throw new Error('valueLimit must be >= 0');
      }
      before.valueLimit = this._props.valueLimit;
      after.valueLimit = updates.valueLimit;
      this._props = { ...this._props, valueLimit: updates.valueLimit };
    }
    return { before, after };
  }
}
