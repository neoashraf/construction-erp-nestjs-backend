/**
 * AttendanceRecord aggregate (PURE — no NestJS/TypeORM). ONE aggregate with a `mode` discriminator
 * (OFFICE / SUBCONTRACTOR / DAILY_LABOUR) — each mode has different required fields and a different
 * downstream effect (design §2.1). Per-mode field invariants are enforced at construction:
 *   - OFFICE       ⇒ employeeId; NO headCount / partyId (feeds payroll — captured, never accrues);
 *   - SUBCONTRACTOR⇒ partyId + costCentreId + headCount ≥ 1 (TRACKING ONLY — posts nothing, FR-HR-005);
 *   - DAILY_LABOUR ⇒ costCentreId + headCount ≥ 1 + dailyRate ≥ 0 (the ONLY accruable mode, FR-HR-006/009).
 * project is required all modes (FR-HR-008); purpose is optional on capture (§5.1 head-count rows).
 * Only DAILY_LABOUR is confirmable: confirm() records the posted accrual entry id and marks CONFIRMED —
 * it is never re-confirmable (AlreadyConfirmedError) and the other modes throw NotAccruableModeError.
 * The aggregate enforces SHAPE + head-count×rate; it does NOT post (attendance.service orchestrates that).
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';
import { AlreadyConfirmedError, NotAccruableModeError } from './errors';

export type AttendanceMode = 'OFFICE' | 'SUBCONTRACTOR' | 'DAILY_LABOUR';
export const ATTENDANCE_MODES: readonly AttendanceMode[] = [
  'OFFICE',
  'SUBCONTRACTOR',
  'DAILY_LABOUR',
] as const;

export type DayStatus = 'PRESENT' | 'PAID_LEAVE' | 'UNPAID_LEAVE' | 'ABSENT';
export const DAY_STATUSES: readonly DayStatus[] = [
  'PRESENT',
  'PAID_LEAVE',
  'UNPAID_LEAVE',
  'ABSENT',
] as const;

export type AttendanceSource = 'MANUAL' | 'BIOMETRIC_IMPORT';
export const ATTENDANCE_SOURCES: readonly AttendanceSource[] = ['MANUAL', 'BIOMETRIC_IMPORT'] as const;

export const ATTENDANCE_SOURCE_TYPE = 'AttendanceRecord';

/** Fields the caller supplies to capture one attendance row (per-mode subset validated at construction). */
export interface NewAttendance {
  mode: AttendanceMode;
  attendanceDate: string; // 'YYYY-MM-DD'
  projectId: string;
  costCentreId?: string | null;
  purposeId?: string | null;
  // OFFICE
  employeeId?: string | null;
  checkIn?: string | null; // 'HH:mm'
  checkOut?: string | null;
  dayStatus?: DayStatus | null;
  overtimeHours?: Money | string | number | null;
  source?: AttendanceSource | null;
  // SUBCONTRACTOR
  partyId?: string | null;
  // SUBCONTRACTOR / DAILY_LABOUR
  headCount?: number | null;
  // DAILY_LABOUR
  labourCategory?: string | null;
  dailyRate?: Money | string | number | null;
}

/** A PATCH of the editable fields of an UNCONFIRMED daily-labour row. */
export interface EditDailyLabour {
  headCount?: number;
  dailyRate?: Money | string | number;
  labourCategory?: string | null;
  purposeId?: string | null;
}

export interface AttendanceProps {
  companyId: string;
  financialYearId: string;
  mode: AttendanceMode;
  attendanceDate: string;
  projectId: string;
  costCentreId: string | null;
  purposeId: string | null;
  employeeId: string | null;
  checkIn: string | null;
  checkOut: string | null;
  dayStatus: DayStatus | null;
  overtimeHours: Money | null;
  partyId: string | null;
  headCount: number | null;
  labourCategory: string | null;
  dailyRate: Money | null;
  source: AttendanceSource;
  isConfirmed: boolean;
  accrualEntryId: string | null;
  version: number;
}

export class AttendanceRecord extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: AttendanceProps,
  ) {
    super(id);
  }

  /** Capture one attendance row, enforcing the per-mode field invariants (FR-HR-004/005/006/008). */
  static capture(
    id: string,
    companyId: string,
    financialYearId: string,
    input: NewAttendance,
  ): AttendanceRecord {
    const mode = reqMode(input.mode);
    const projectId = req(input.projectId, 'projectId');
    const attendanceDate = reqDate(input.attendanceDate, 'attendanceDate');
    const purposeId = emptyToNull(input.purposeId);

    const base: AttendanceProps = {
      companyId,
      financialYearId,
      mode,
      attendanceDate,
      projectId,
      costCentreId: null,
      purposeId,
      employeeId: null,
      checkIn: null,
      checkOut: null,
      dayStatus: null,
      overtimeHours: null,
      partyId: null,
      headCount: null,
      labourCategory: null,
      dailyRate: null,
      source: 'MANUAL',
      isConfirmed: false,
      accrualEntryId: null,
      version: 1,
    };

    if (mode === 'OFFICE') {
      if (input.headCount != null || input.partyId) {
        throw new ValidationError('OFFICE attendance must not carry headCount or partyId', {
          field: 'mode',
        });
      }
      base.employeeId = req(input.employeeId ?? '', 'employeeId');
      base.checkIn = emptyToNull(input.checkIn);
      base.checkOut = emptyToNull(input.checkOut);
      base.dayStatus = reqDayStatus(input.dayStatus);
      base.overtimeHours = toNonNegMoney(input.overtimeHours ?? '0', 'overtimeHours');
      base.source = reqSource(input.source);
    } else if (mode === 'SUBCONTRACTOR') {
      base.partyId = req(input.partyId ?? '', 'partyId');
      base.costCentreId = req(input.costCentreId ?? '', 'costCentreId');
      base.headCount = reqHeadCount(input.headCount);
    } else {
      // DAILY_LABOUR
      base.costCentreId = req(input.costCentreId ?? '', 'costCentreId');
      base.headCount = reqHeadCount(input.headCount);
      base.dailyRate = toNonNegMoney(input.dailyRate ?? null, 'dailyRate');
      base.labourCategory = emptyToNull(input.labourCategory);
    }

    return new AttendanceRecord(id, base);
  }

  static rehydrate(id: string, props: AttendanceProps): AttendanceRecord {
    return new AttendanceRecord(id, props);
  }

  /** Edit an UNCONFIRMED daily-labour row (FR-HR-006). Throws if not daily-labour or already confirmed. */
  editDailyLabour(patch: EditDailyLabour): void {
    this.assertAccruable();
    this.assertUnconfirmed();
    const p = this._props;
    if (patch.headCount !== undefined) p.headCount = reqHeadCount(patch.headCount);
    if (patch.dailyRate !== undefined) p.dailyRate = toNonNegMoney(patch.dailyRate, 'dailyRate');
    if (patch.labourCategory !== undefined) p.labourCategory = emptyToNull(patch.labourCategory);
    if (patch.purposeId !== undefined) p.purposeId = emptyToNull(patch.purposeId);
  }

  /** Set/override the accrual purpose at confirm time (accrual matrix requires it — FR-HR-010). */
  setPurpose(purposeId: string): void {
    this._props.purposeId = req(purposeId, 'purposeId');
  }

  /**
   * Mark this DAILY_LABOUR row CONFIRMED, recording the posted accrual entry id. Only DAILY_LABOUR is
   * accruable (NotAccruableModeError); a row may be confirmed once (AlreadyConfirmedError).
   */
  confirm(accrualEntryId: string): void {
    this.assertAccruable();
    this.assertUnconfirmed();
    this._props.isConfirmed = true;
    this._props.accrualEntryId = req(accrualEntryId, 'accrualEntryId');
  }

  /** Guard: only DAILY_LABOUR accrues (FR-HR-005 — subcontractor/office are not accruable). */
  assertAccruable(): void {
    if (!this.isAccruable) throw new NotAccruableModeError(this._props.mode);
  }

  /** Guard: the row has not been confirmed yet (anti-double-confirm; re-confirm rejected — edge §12.1). */
  assertUnconfirmed(): void {
    if (this._props.isConfirmed) throw new AlreadyConfirmedError(this.id);
  }

  /** Accrued cost = headCount × dailyRate in EXACT decimal (DAILY_LABOUR only). */
  accruedCost(): Money {
    this.assertAccruable();
    const rate = this._props.dailyRate ?? Money.zero();
    const count = new Decimal(this._props.headCount ?? 0);
    return rate.times(count).round();
  }

  get isAccruable(): boolean {
    return this._props.mode === 'DAILY_LABOUR';
  }

  get isConfirmed(): boolean {
    return this._props.isConfirmed;
  }

  get props(): Readonly<AttendanceProps> {
    return this._props;
  }

  get version(): number {
    return this._props.version;
  }
}

// ---- helpers -------------------------------------------------------------------------------------

function reqMode(v: AttendanceMode): AttendanceMode {
  if (!ATTENDANCE_MODES.includes(v)) {
    throw new ValidationError(`mode must be one of ${ATTENDANCE_MODES.join(', ')}`, { field: 'mode', value: v });
  }
  return v;
}

function reqDayStatus(v: DayStatus | null | undefined): DayStatus {
  if (!v || !DAY_STATUSES.includes(v)) {
    throw new ValidationError(`dayStatus must be one of ${DAY_STATUSES.join(', ')}`, { field: 'dayStatus' });
  }
  return v;
}

function reqSource(v: AttendanceSource | null | undefined): AttendanceSource {
  const s = v ?? 'MANUAL';
  if (!ATTENDANCE_SOURCES.includes(s)) {
    throw new ValidationError(`source must be one of ${ATTENDANCE_SOURCES.join(', ')}`, { field: 'source' });
  }
  return s;
}

function reqHeadCount(v: number | null | undefined): number {
  if (v == null || !Number.isInteger(v) || v < 1) {
    throw new ValidationError('headCount must be an integer >= 1', { field: 'headCount', value: v });
  }
  return v;
}

function toNonNegMoney(value: Money | string | number | null, field: string): Money {
  if (value instanceof Money) {
    if (value.isNegative()) throw new ValidationError(`${field} must be >= 0`, { field });
    return value;
  }
  if (value === null || value === undefined || value === '') {
    throw new ValidationError(`${field} is required`, { field });
  }
  let m: Money;
  try {
    m = Money.of(value);
  } catch {
    throw new ValidationError(`${field} is not a valid amount`, { field, value: String(value) });
  }
  if (m.isNegative()) throw new ValidationError(`${field} must be >= 0`, { field });
  return m;
}

function req(v: string, field: string): string {
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
