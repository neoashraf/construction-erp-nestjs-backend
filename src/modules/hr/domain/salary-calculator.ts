/**
 * SalaryCalculator (PURE — decimal.js only, no NestJS/TypeORM). The office-staff gross-pay + net-pay math
 * (design §2.2, FR-HR-013/-014):
 *   calcGross  — MONTHLY: monthlySalary × (paidDays / standardDays) + overtime (exact Decimal, 4dp);
 *                DAILY  : dailyRate × attendedDays + overtime.
 *   applyComponents — { gross, allowances, tds, pf, advanceRecovery, other, net } where
 *                      net = gross + allowances − (tds + pf + advanceRecovery + other).
 * All money is `Money` (decimal.js under the hood, ADR-0001 #10) — never JS float arithmetic.
 */
import Decimal from 'decimal.js';
import { ValidationError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';

export type WageType = 'MONTHLY' | 'DAILY';

/** The employee facts the gross calculation needs (a thin projection of the Employee master). */
export interface EmployeePayInfo {
  wageType: WageType;
  /** Monthly salary (MONTHLY) or daily rate (DAILY). */
  wageAmount: Money;
}

/** The period's attendance summary for one employee, pre-aggregated from AttendanceRecord rows. */
export interface AttendanceSummary {
  /** MONTHLY: days paid (present + paid leave) this period. */
  paidDays: Money | string | number;
  /** MONTHLY: the period's standard working days (company/period config; typically the calendar days). */
  standardDays: Money | string | number;
  /** DAILY: days actually attended this period. */
  attendedDays: Money | string | number;
  /** Overtime pay already computed in money terms (hours × rate), both wage types. Defaults to 0. */
  overtimeAmount?: Money | string | number | null;
}

/** Configurable allowance/deduction lines applied on top of gross (FR-HR-014). All default to 0. */
export interface PayComponents {
  allowances?: Money | string | number | null;
  tds?: Money | string | number | null;
  pf?: Money | string | number | null;
  advanceRecovery?: Money | string | number | null;
  other?: Money | string | number | null;
}

export interface SalaryLineAmounts {
  gross: Money;
  allowances: Money;
  tds: Money;
  pf: Money;
  advanceRecovery: Money;
  other: Money;
  net: Money;
}

/**
 * Gross pay for one employee for one period.
 *   MONTHLY: wageAmount × (paidDays / standardDays) + overtime  (round to 4dp at the end)
 *   DAILY  : wageAmount × attendedDays + overtime
 */
export function calcGross(emp: EmployeePayInfo, att: AttendanceSummary): Money {
  const overtime = toMoney(att.overtimeAmount ?? '0', 'overtimeAmount');
  if (overtime.isNegative()) throw new ValidationError('overtimeAmount must be >= 0', { field: 'overtimeAmount' });

  if (emp.wageType === 'MONTHLY') {
    const standardDays = toDecimal(att.standardDays, 'standardDays');
    if (!standardDays.greaterThan(0)) {
      throw new ValidationError('standardDays must be > 0 for a MONTHLY employee', { field: 'standardDays' });
    }
    const paidDays = toDecimal(att.paidDays, 'paidDays');
    if (paidDays.isNegative()) throw new ValidationError('paidDays must be >= 0', { field: 'paidDays' });
    const prorated = emp.wageAmount.amount.times(paidDays).dividedBy(standardDays);
    return Money.of(prorated).round().plus(overtime.round());
  }

  if (emp.wageType === 'DAILY') {
    const attendedDays = toDecimal(att.attendedDays, 'attendedDays');
    if (attendedDays.isNegative()) throw new ValidationError('attendedDays must be >= 0', { field: 'attendedDays' });
    const earned = emp.wageAmount.amount.times(attendedDays);
    return Money.of(earned).round().plus(overtime.round());
  }

  throw new ValidationError(`wageType must be MONTHLY or DAILY`, { field: 'wageType', value: emp.wageType });
}

/**
 * Apply configured allowance/deduction components to a computed gross (FR-HR-014).
 * net = gross + allowances − (tds + pf + advanceRecovery + other). All figures rounded to 4dp;
 * a negative component (allowances/tds/pf/advanceRecovery/other) is rejected.
 */
export function applyComponents(gross: Money, cfg: PayComponents): SalaryLineAmounts {
  const allowances = nonNegMoney(cfg.allowances, 'allowances');
  const tds = nonNegMoney(cfg.tds, 'tds');
  const pf = nonNegMoney(cfg.pf, 'pf');
  const advanceRecovery = nonNegMoney(cfg.advanceRecovery, 'advanceRecovery');
  const other = nonNegMoney(cfg.other, 'other');

  const deductions = tds.plus(pf).plus(advanceRecovery).plus(other);
  const net = gross.plus(allowances).minus(deductions);

  return {
    gross: gross.round(),
    allowances: allowances.round(),
    tds: tds.round(),
    pf: pf.round(),
    advanceRecovery: advanceRecovery.round(),
    other: other.round(),
    net: net.round(),
  };
}

// ---- helpers -------------------------------------------------------------------------------------

function toDecimal(value: Money | string | number, field: string): Decimal {
  if (value instanceof Money) return value.amount;
  if (value === null || value === undefined || value === ('' as unknown)) {
    throw new ValidationError(`${field} is required`, { field });
  }
  try {
    const d = new Decimal(value);
    if (!d.isFinite()) throw new Error('not finite');
    return d;
  } catch {
    throw new ValidationError(`${field} is not a valid number`, { field, value: String(value) });
  }
}

function toMoney(value: Money | string | number, field: string): Money {
  return value instanceof Money ? value : Money.of(toDecimal(value, field));
}

function nonNegMoney(value: Money | string | number | null | undefined, field: string): Money {
  if (value === null || value === undefined) return Money.zero();
  const m = toMoney(value, field);
  if (m.isNegative()) throw new ValidationError(`${field} must be >= 0`, { field });
  return m;
}
