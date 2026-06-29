/**
 * FinancialYear — organisation master (MAS, FR-MAS-002, FR-MAS-003). PURE domain TypeScript.
 * Per-company; overlapping years are allowed; at most one is active per company (the partial-unique
 * index in the migration is the DB backstop, the `SetActiveFinancialYear` use case the orchestrator).
 * The one genuine domain invariant guarded here is `end_date > start_date` (SRS §11).
 */
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { DateOnly } from '../../../../common/value-objects/date-only';
import { IdGenerator } from '../../../../common/ports/id-generator.port';

export interface NewFinancialYear {
  companyId: string;
  label: string;
  startDate: string;
  endDate: string;
}

export interface FinancialYearProps {
  companyId: string;
  label: string;
  startDate: DateOnly;
  endDate: DateOnly;
  isActive: boolean;
  /** Optimistic-concurrency token (FR-MAS-032). */
  version: number;
}

export class FinancialYear extends Entity<string> {
  private constructor(
    id: string,
    private _props: FinancialYearProps,
  ) {
    super(id);
  }

  /** Create a new financial year — inactive until explicitly set active (FR-MAS-002, FR-MAS-003). */
  static create(input: NewFinancialYear, ids: IdGenerator): FinancialYear {
    const startDate = DateOnly.of(input.startDate);
    const endDate = DateOnly.of(input.endDate);
    FinancialYear.assertRange(startDate, endDate);
    return new FinancialYear(ids.next(), {
      companyId: input.companyId,
      label: FinancialYear.requireText(input.label, 'label'),
      startDate,
      endDate,
      isActive: false,
      version: 1,
    });
  }

  /** Rehydrate from persistence (trusted data; no re-validation). */
  static rehydrate(id: string, props: FinancialYearProps): FinancialYear {
    return new FinancialYear(id, props);
  }

  /** Edit label / bounds (FR-MAS-002). Undefined fields unchanged; range re-checked when a bound moves. */
  update(input: { label?: string; startDate?: string; endDate?: string }): void {
    if (input.label !== undefined) this._props.label = FinancialYear.requireText(input.label, 'label');
    const startDate = input.startDate !== undefined ? DateOnly.of(input.startDate) : this._props.startDate;
    const endDate = input.endDate !== undefined ? DateOnly.of(input.endDate) : this._props.endDate;
    if (input.startDate !== undefined || input.endDate !== undefined) {
      FinancialYear.assertRange(startDate, endDate);
      this._props.startDate = startDate;
      this._props.endDate = endDate;
    }
  }

  /** Mark active (FR-MAS-003). The use case clears the prior active FY in the same transaction. */
  activate(): void {
    this._props.isActive = true;
  }

  /** Clear the active flag (used when switching the active FY). */
  deactivate(): void {
    this._props.isActive = false;
  }

  get props(): Readonly<FinancialYearProps> {
    return this._props;
  }

  get version(): number {
    return this._props.version;
  }

  get isActive(): boolean {
    return this._props.isActive;
  }

  private static assertRange(start: DateOnly, end: DateOnly): void {
    if (!end.isAfter(start)) {
      throw new ValidationError('end_date must be after start_date', {
        startDate: start.value,
        endDate: end.value,
      });
    }
  }

  private static requireText(value: string, field: string): string {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0) {
      throw new ValidationError(`${field} is required`, { field });
    }
    return trimmed;
  }
}
