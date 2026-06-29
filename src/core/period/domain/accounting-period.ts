/**
 * AccountingPeriod — PER aggregate (PURE; rich-small). Per company + financial year; inclusive
 * `[startDate, endDate]`; OPEN↔CLOSED FSM. `close` (OPEN→CLOSED only) stamps closedAt/closedBy;
 * `reopen` (CLOSED→OPEN only) clears them. Out-of-state transitions throw domain errors
 * (FR-PER-001/008/009). No money, no posting.
 */
import { Entity } from '../../../common/domain/domain';
import { Clock } from '../../../common/ports/clock.port';
import { DateOnly } from '../../../common/value-objects/date-only';
import { PeriodAlreadyClosedError, PeriodAlreadyOpenError } from './errors';

export type PeriodStatus = 'OPEN' | 'CLOSED';

export interface AccountingPeriodProps {
  companyId: string;
  financialYearId: string;
  name: string;
  startDate: DateOnly;
  endDate: DateOnly;
  status: PeriodStatus;
  closedAt: Date | null;
  closedBy: string | null;
  version: number;
}

export class AccountingPeriod extends Entity<string> {
  private constructor(
    id: string,
    private _props: AccountingPeriodProps,
  ) {
    super(id);
  }

  static create(
    id: string,
    input: {
      companyId: string;
      financialYearId: string;
      name: string;
      startDate: DateOnly;
      endDate: DateOnly;
    },
  ): AccountingPeriod {
    return new AccountingPeriod(id, {
      ...input,
      status: 'OPEN',
      closedAt: null,
      closedBy: null,
      version: 1,
    });
  }

  static rehydrate(id: string, props: AccountingPeriodProps): AccountingPeriod {
    return new AccountingPeriod(id, props);
  }

  /** OPEN → CLOSED; stamps closedAt/closedBy. Throws if not OPEN (FR-PER-008). */
  close(actorId: string, clock: Clock): void {
    if (this._props.status !== 'OPEN') throw new PeriodAlreadyClosedError(this.id);
    this._props.status = 'CLOSED';
    this._props.closedAt = clock.now();
    this._props.closedBy = actorId;
  }

  /** CLOSED → OPEN; clears stamps. Throws if not CLOSED (FR-PER-009). */
  reopen(): void {
    if (this._props.status !== 'CLOSED') throw new PeriodAlreadyOpenError(this.id);
    this._props.status = 'OPEN';
    this._props.closedAt = null;
    this._props.closedBy = null;
  }

  isOpen(): boolean {
    return this._props.status === 'OPEN';
  }

  /** True if `date` (YYYY-MM-DD) falls within [startDate, endDate], boundaries inclusive (FR-PER-005). */
  owns(date: string): boolean {
    return date >= this._props.startDate.value && date <= this._props.endDate.value;
  }

  get props(): Readonly<AccountingPeriodProps> {
    return this._props;
  }

  get version(): number {
    return this._props.version;
  }
}
