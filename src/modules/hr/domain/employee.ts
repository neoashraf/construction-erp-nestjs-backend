/**
 * Employee aggregate + EmployeeAssignment (PURE — no NestJS/TypeORM). The office-staff master: ONLY named
 * corporate employees (daily labourers / subcontractor workers are head counts, never employees — policy
 * reject, FR-HR-001). Owns its identity/pay/bank fields, an ACTIVE/INACTIVE lifecycle (deactivate-not-
 * delete), and an APPEND-ONLY reassignment history (FR-HR-002): reassign() appends a new EmployeeAssignment
 * and never overwrites a prior one. INACTIVE employees are excluded from new attendance/salary cycles
 * (FR-HR-003). Money is Money/decimal.js; wage_amount ≥ 0. This file holds shape + lifecycle only.
 */
import { AggregateRoot, Entity } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';
import { Tin } from '../../../common/value-objects/tin';
import { EffectiveDateBeforeJoiningError } from './errors';

export type WageType = 'MONTHLY' | 'DAILY';
export const WAGE_TYPES: readonly WageType[] = ['MONTHLY', 'DAILY'] as const;

export type WorkBase = 'HEAD_OFFICE' | 'SITE';
export const WORK_BASES: readonly WorkBase[] = ['HEAD_OFFICE', 'SITE'] as const;

export type EmployeeStatus = 'ACTIVE' | 'INACTIVE';
export const EMPLOYEE_STATUSES: readonly EmployeeStatus[] = ['ACTIVE', 'INACTIVE'] as const;

export const EMPLOYEE_SOURCE_TYPE = 'Employee';

/** Fields the caller supplies to create an office-staff employee. Money accepts string/number/Decimal. */
export interface NewEmployee {
  employeeCode: string;
  name: string;
  designation: string;
  defaultProjectId?: string | null;
  department?: string | null;
  workBase: WorkBase;
  wageType: WageType;
  wageAmount: Money | string | number;
  bankAccountName?: string | null;
  bankAccountNo?: string | null;
  bankName?: string | null;
  pfApplicable?: boolean;
  gratuityApplicable?: boolean;
  wppfApplicable?: boolean;
  tin?: string | null;
  joiningDate: string; // 'YYYY-MM-DD'
}

/** A PATCH of the descriptive/pay/bank fields; omitted fields keep the current value (code is immutable). */
export interface EditEmployee {
  name?: string;
  designation?: string;
  defaultProjectId?: string | null;
  department?: string | null;
  workBase?: WorkBase;
  wageType?: WageType;
  wageAmount?: Money | string | number;
  bankAccountName?: string | null;
  bankAccountNo?: string | null;
  bankName?: string | null;
  pfApplicable?: boolean;
  gratuityApplicable?: boolean;
  wppfApplicable?: boolean;
  tin?: string | null;
}

export interface EmployeeProps {
  companyId: string;
  employeeCode: string;
  name: string;
  designation: string;
  defaultProjectId: string | null;
  department: string | null;
  workBase: WorkBase;
  wageType: WageType;
  wageAmount: Money;
  bankAccountName: string | null;
  bankAccountNo: string | null;
  bankName: string | null;
  pfApplicable: boolean;
  gratuityApplicable: boolean;
  wppfApplicable: boolean;
  tin: string | null;
  joiningDate: string;
  status: EmployeeStatus;
  version: number;
}

export interface EmployeeAssignmentProps {
  employeeId: string;
  companyId: string;
  projectId: string;
  effectiveDate: string; // 'YYYY-MM-DD'
  note: string | null;
}

/** A row of the append-only reassignment history (FR-HR-002). Never mutated once written. */
export class EmployeeAssignment extends Entity<string> {
  private constructor(
    id: string,
    readonly props: EmployeeAssignmentProps,
  ) {
    super(id);
  }

  static create(id: string, props: EmployeeAssignmentProps): EmployeeAssignment {
    return new EmployeeAssignment(id, props);
  }

  static rehydrate(id: string, props: EmployeeAssignmentProps): EmployeeAssignment {
    return new EmployeeAssignment(id, props);
  }
}

export class Employee extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: EmployeeProps,
  ) {
    super(id);
  }

  /**
   * Build an ACTIVE office-staff employee (version 1). Validates the required fields, the wage amount
   * (≥ 0), the TIN format (when supplied), and the joining date. No ledger impact.
   */
  static create(id: string, companyId: string, input: NewEmployee): Employee {
    const wageAmount = toMoney(input.wageAmount, 'wageAmount');
    if (wageAmount.isNegative()) {
      throw new ValidationError('wageAmount must be >= 0', { field: 'wageAmount' });
    }
    return new Employee(id, {
      companyId,
      employeeCode: req(input.employeeCode, 'employeeCode'),
      name: reqText(input.name, 'name'),
      designation: reqText(input.designation, 'designation'),
      defaultProjectId: emptyToNull(input.defaultProjectId),
      department: emptyToNull(input.department),
      workBase: reqWorkBase(input.workBase),
      wageType: reqWageType(input.wageType),
      wageAmount,
      bankAccountName: emptyToNull(input.bankAccountName),
      bankAccountNo: emptyToNull(input.bankAccountNo),
      bankName: emptyToNull(input.bankName),
      pfApplicable: input.pfApplicable ?? false,
      gratuityApplicable: input.gratuityApplicable ?? false,
      wppfApplicable: input.wppfApplicable ?? false,
      tin: normalizeTin(input.tin),
      joiningDate: reqDate(input.joiningDate, 'joiningDate'),
      status: 'ACTIVE',
      version: 1,
    });
  }

  static rehydrate(id: string, props: EmployeeProps): Employee {
    return new Employee(id, props);
  }

  /** Edit descriptive / pay / bank fields (employee_code is immutable — never patched here). */
  update(patch: EditEmployee): void {
    const p = this._props;
    if (patch.name !== undefined) p.name = reqText(patch.name, 'name');
    if (patch.designation !== undefined) p.designation = reqText(patch.designation, 'designation');
    if (patch.defaultProjectId !== undefined) p.defaultProjectId = emptyToNull(patch.defaultProjectId);
    if (patch.department !== undefined) p.department = emptyToNull(patch.department);
    if (patch.workBase !== undefined) p.workBase = reqWorkBase(patch.workBase);
    if (patch.wageType !== undefined) p.wageType = reqWageType(patch.wageType);
    if (patch.wageAmount !== undefined) {
      const wage = toMoney(patch.wageAmount, 'wageAmount');
      if (wage.isNegative()) throw new ValidationError('wageAmount must be >= 0', { field: 'wageAmount' });
      p.wageAmount = wage;
    }
    if (patch.bankAccountName !== undefined) p.bankAccountName = emptyToNull(patch.bankAccountName);
    if (patch.bankAccountNo !== undefined) p.bankAccountNo = emptyToNull(patch.bankAccountNo);
    if (patch.bankName !== undefined) p.bankName = emptyToNull(patch.bankName);
    if (patch.pfApplicable !== undefined) p.pfApplicable = patch.pfApplicable;
    if (patch.gratuityApplicable !== undefined) p.gratuityApplicable = patch.gratuityApplicable;
    if (patch.wppfApplicable !== undefined) p.wppfApplicable = patch.wppfApplicable;
    if (patch.tin !== undefined) p.tin = normalizeTin(patch.tin);
  }

  /**
   * Reassign to another project with an effective date; sets the new default project and RETURNS the new
   * append-only history row (FR-HR-002). The caller persists that row alongside the employee — a prior
   * assignment is never overwritten. effectiveDate must be on/after the joining date.
   */
  reassign(
    assignmentId: string,
    projectId: string,
    effectiveDate: string,
    note: string | null,
  ): EmployeeAssignment {
    const project = req(projectId, 'projectId');
    const effective = reqDate(effectiveDate, 'effectiveDate');
    if (effective < this._props.joiningDate) {
      throw new EffectiveDateBeforeJoiningError(effective, this._props.joiningDate);
    }
    this._props.defaultProjectId = project;
    return EmployeeAssignment.create(assignmentId, {
      employeeId: this.id,
      companyId: this._props.companyId,
      projectId: project,
      effectiveDate: effective,
      note: note && note.trim() ? note.trim() : null,
    });
  }

  deactivate(): void {
    this._props.status = 'INACTIVE';
  }

  reactivate(): void {
    this._props.status = 'ACTIVE';
  }

  get isActive(): boolean {
    return this._props.status === 'ACTIVE';
  }

  get props(): Readonly<EmployeeProps> {
    return this._props;
  }

  get version(): number {
    return this._props.version;
  }
}

// ---- helpers -------------------------------------------------------------------------------------

function toMoney(value: Money | string | number, field: string): Money {
  if (value instanceof Money) return value;
  if (value === null || value === undefined || value === '') {
    throw new ValidationError(`${field} is required`, { field });
  }
  try {
    return Money.of(value);
  } catch {
    throw new ValidationError(`${field} is not a valid amount`, { field, value: String(value) });
  }
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}

function reqText(v: string, field: string): string {
  // Names/designations may be Bangla (UTF-8) — trim only, never truncate.
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}

function emptyToNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

function reqDate(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    throw new ValidationError(`${field} must be a YYYY-MM-DD date`, { field, value: v });
  }
  return t;
}

function reqWageType(v: WageType): WageType {
  if (!WAGE_TYPES.includes(v)) {
    throw new ValidationError(`wageType must be one of ${WAGE_TYPES.join(', ')}`, { field: 'wageType', value: v });
  }
  return v;
}

function reqWorkBase(v: WorkBase): WorkBase {
  if (!WORK_BASES.includes(v)) {
    throw new ValidationError(`workBase must be one of ${WORK_BASES.join(', ')}`, { field: 'workBase', value: v });
  }
  return v;
}

/** Validate the TIN format (12 digits) when present; null when blank. */
function normalizeTin(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  return Tin.of(t).value;
}
