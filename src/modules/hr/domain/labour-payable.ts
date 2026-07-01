/**
 * LabourPayable (PURE — no NestJS/TypeORM). The liability accrued alongside the daily-labour accrual
 * (per project + cost centre + confirmation date/run), written by HR at head-count confirmation and
 * SETTLED by PAY (FR-HR-011). HR NEVER re-expenses at payment: it consumes PAY's JournalEntryPosted event
 * and rolls up `settledAmount` / `status` (OUTSTANDING → PARTIALLY_SETTLED → SETTLED) on THIS read model
 * only — the posted accrual entry is untouched (accrual → settlement boundary, overview §8 decision 8).
 */
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';

export type LabourPayableStatus = 'OUTSTANDING' | 'PARTIALLY_SETTLED' | 'SETTLED';
export const LABOUR_PAYABLE_STATUSES: readonly LabourPayableStatus[] = [
  'OUTSTANDING',
  'PARTIALLY_SETTLED',
  'SETTLED',
] as const;

export interface NewLabourPayable {
  companyId: string;
  financialYearId: string;
  projectId: string;
  costCentreId: string;
  accrualDate: string; // 'YYYY-MM-DD'
  accruedAmount: Money;
  accrualEntryId: string;
}

export interface LabourPayableProps {
  companyId: string;
  financialYearId: string;
  projectId: string;
  costCentreId: string;
  accrualDate: string;
  accruedAmount: Money;
  accrualEntryId: string;
  settledAmount: Money;
  status: LabourPayableStatus;
  version: number;
}

export class LabourPayable extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: LabourPayableProps,
  ) {
    super(id);
  }

  /** Create the OUTSTANDING payable that the daily-labour accrual just created. settled = 0. */
  static create(id: string, input: NewLabourPayable): LabourPayable {
    return new LabourPayable(id, {
      companyId: input.companyId,
      financialYearId: input.financialYearId,
      projectId: input.projectId,
      costCentreId: input.costCentreId,
      accrualDate: input.accrualDate,
      accruedAmount: input.accruedAmount,
      accrualEntryId: input.accrualEntryId,
      settledAmount: Money.zero(),
      status: 'OUTSTANDING',
      version: 1,
    });
  }

  static rehydrate(id: string, props: LabourPayableProps): LabourPayable {
    return new LabourPayable(id, props);
  }

  /**
   * Apply a PAY settlement (from a JournalEntryPosted event) to the rollup — HR posts NOTHING here
   * (FR-HR-011). Adds to `settledAmount` (capped at accrued) and re-derives `status`.
   */
  applySettlement(amount: Money): void {
    if (amount.isNegative()) {
      throw new ValidationError('settlement amount must be >= 0', { field: 'amount' });
    }
    const next = this._props.settledAmount.plus(amount);
    // Never let the rollup exceed the accrued amount (a small over-payment difference is PAY's concern).
    this._props.settledAmount = next.amount.greaterThan(this._props.accruedAmount.amount)
      ? this._props.accruedAmount
      : next;
    this._props.status = this.deriveStatus();
  }

  private deriveStatus(): LabourPayableStatus {
    const settled = this._props.settledAmount.amount;
    if (settled.isZero()) return 'OUTSTANDING';
    if (settled.greaterThanOrEqualTo(this._props.accruedAmount.amount)) return 'SETTLED';
    return 'PARTIALLY_SETTLED';
  }

  get props(): Readonly<LabourPayableProps> {
    return this._props;
  }

  get version(): number {
    return this._props.version;
  }
}
