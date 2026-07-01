/**
 * RetentionRelease aggregate root (PURE — no NestJS/TypeORM). A controlled, separate posting that moves a
 * previously-withheld retention amount from Retention Receivable to currently-due Accounts Receivable for
 * one IPC (FR-SAL-018..020; design §2.3/§4.2). Draft -> posted lifecycle, mirroring Ipc's shape but with no
 * edit-in-place (a release is created with its final amount and posted, or discarded as a draft).
 *
 * `assertReleasable(retentionHeld)` enforces `0 < releasedAmount <= retentionHeld` (FR-SAL-019, edge case
 * 7) — the boundary is inclusive at the top (releasing exactly what's held is allowed and drops held to
 * zero) and exclusive at the bottom (a zero/negative release is rejected as ValidationError, an over-
 * release as OverReleaseError). `toPostingCommand` builds the exact §4.2 two-line balanced movement — Dr
 * Accounts Receivable / Cr Retention Receivable, both carrying project + cost_centre + purpose + the
 * customer party. See the comment on `toPostingCommand` for the voucherType interim-choice note.
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';
import { PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { OverReleaseError } from './errors';
import { SalesAccountMap } from './ipc-posting';

export const RETENTION_RELEASE_SOURCE_TYPE = 'RetentionRelease';

export type RetentionReleaseStatus = 'DRAFT' | 'POSTED' | 'CANCELLED';

const MONEY_SCALE = 4;

/**
 * The release only needs the AR + Retention Receivable ids, but reuses the full `SalesAccountMap`
 * (SAL's single resolved-account-map shape from `sales-ipc-core`) rather than inventing a parallel/narrower
 * account resolver — per the brief's explicit reuse instruction.
 */
export type RetentionReleaseAccountMap = Pick<SalesAccountMap, 'accountsReceivable' | 'retentionReceivable'>;

export interface NewRetentionRelease {
  companyId: string;
  financialYearId: string;
  ipcId: string;
  projectId: string;
  customerId: string;
  costCentreId: string;
  purposeId: string;
  releaseDate: string; // 'YYYY-MM-DD'
  releasedAmount: Decimal | string | number;
  narration?: string | null;
}

export interface RetentionReleaseProps {
  companyId: string;
  financialYearId: string;
  ipcId: string;
  projectId: string;
  customerId: string;
  costCentreId: string;
  purposeId: string;
  releaseDate: string;
  releasedAmount: Money;
  narration: string | null;
  status: RetentionReleaseStatus;
  entryNo: string | null;
  journalEntryId: string | null;
  postedAt: Date | null;
  postedBy: string | null;
  version: number;
}

export class RetentionRelease extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: RetentionReleaseProps,
  ) {
    super(id);
  }

  /**
   * Build a DRAFT release. `retentionHeld` is the authoritative held figure at build time (read via
   * ReceiptAllocationPort); `assertReleasable` re-validates it — callers should re-check inside the post
   * transaction against a freshly-read held figure (mirrors Ipc's advance re-cap pattern, FR-SAL-008).
   */
  static createDraft(id: string, input: NewRetentionRelease, retentionHeld: Money): RetentionRelease {
    const amount = round4(toDecimal(input.releasedAmount, 'releasedAmount'));
    const release = new RetentionRelease(id, {
      companyId: req(input.companyId, 'companyId'),
      financialYearId: req(input.financialYearId, 'financialYearId'),
      ipcId: req(input.ipcId, 'ipcId'),
      projectId: req(input.projectId, 'projectId'),
      customerId: req(input.customerId, 'customerId'),
      costCentreId: req(input.costCentreId, 'costCentreId'),
      purposeId: req(input.purposeId, 'purposeId'),
      releaseDate: req(input.releaseDate, 'releaseDate'),
      releasedAmount: Money.of(amount),
      narration: input.narration ?? null,
      status: 'DRAFT',
      entryNo: null,
      journalEntryId: null,
      postedAt: null,
      postedBy: null,
      version: 1,
    });
    release.assertReleasable(retentionHeld);
    return release;
  }

  static rehydrate(id: string, props: RetentionReleaseProps): RetentionRelease {
    return new RetentionRelease(id, props);
  }

  /**
   * `0 < releasedAmount <= retentionHeld` (FR-SAL-019, edge case 7). Releasing exactly the held amount
   * passes and drops held to zero; anything beyond it throws OverReleaseError. A non-positive amount is a
   * ValidationError (caught earlier by createDraft's toDecimal/round4, but re-asserted here defensively so
   * a re-check inside the post transaction against a fresh `retentionHeld` also catches drift).
   */
  assertReleasable(retentionHeld: Money): void {
    const amount = this._props.releasedAmount.amount;
    if (!amount.greaterThan(0)) {
      throw new ValidationError('releasedAmount must be > 0', { releasedAmount: amount.toFixed(MONEY_SCALE) });
    }
    if (amount.greaterThan(retentionHeld.amount)) {
      throw new OverReleaseError(amount.toFixed(MONEY_SCALE), retentionHeld.amount.toFixed(MONEY_SCALE));
    }
  }

  assertPostable(): void {
    this.assertDraft();
  }

  markPosted(entryId: string, entryNo: string, by: string, at: Date): void {
    this.assertDraft();
    this._props.status = 'POSTED';
    this._props.journalEntryId = entryId;
    this._props.entryNo = entryNo;
    this._props.postedBy = by;
    this._props.postedAt = at;
  }

  /**
   * The §4.2 worked template, in code — the ONLY place the retention-release Dr/Cr mapping lives:
   *   1. Dr Accounts Receivable (control) = releasedAmount   [project + cost_centre + purpose + party]
   *   2. Cr Retention Receivable          = releasedAmount   [project + cost_centre + purpose + party]
   * Balanced by construction (a single amount on both lines).
   *
   * INTERIM CHOICE (flagged per the brief's DoD + design §10 / SRS §16 open question): this release posts
   * under `voucherType: 'JOURNAL'` — no new voucher type, no new NUM series, reusing the JOURNAL gapless
   * series (design §10 recommendation, SRS §16 "RESOLVED (Phase 1; subject to client revision)"). LED's
   * TagMatrix per-line JOURNAL rule only forces project/cost_centre/purpose on P&L (INCOME/EXPENSE) lines,
   * and party only on control-account lines — our two lines are both ASSET (AR, Retention Receivable), so
   * the bare matrix would not force the four dims here. SAL supplies them anyway: this is SAL's OWN
   * business rule (mirrors the §4.2 template and the AR/retention tagging already used on the IPC posting
   * itself), stricter than LED's bare-minimum JOURNAL requirement — defense in depth, matching how GEN's
   * P&L-lines rule is applied. If the LED/NUM owner later introduces a dedicated release series, only this
   * function's `voucherType` changes.
   */
  toPostingCommand(accounts: RetentionReleaseAccountMap, postedBy: string): PostingCommand {
    const p = this._props;
    const dims = { projectId: p.projectId, costCentreId: p.costCentreId, purposeId: p.purposeId };
    const amount = p.releasedAmount.amount;

    const lines: PostingLine[] = [
      {
        accountId: accounts.accountsReceivable,
        ...dims,
        partyId: p.customerId,
        debit: Money.of(amount),
        credit: Money.zero(),
        accountType: 'ASSET',
        isControlAccount: true,
      },
      {
        accountId: accounts.retentionReceivable,
        ...dims,
        partyId: p.customerId,
        debit: Money.zero(),
        credit: Money.of(amount),
        accountType: 'ASSET',
        isControlAccount: true,
      },
    ];

    return {
      companyId: p.companyId,
      financialYearId: p.financialYearId,
      voucherType: 'JOURNAL',
      voucherDate: p.releaseDate,
      sourceType: RETENTION_RELEASE_SOURCE_TYPE,
      sourceId: this.id,
      postedBy,
      narration: p.narration ?? undefined,
      lines,
    };
  }

  private assertDraft(): void {
    if (this._props.status !== 'DRAFT') {
      throw new ValidationError(`Only a DRAFT retention release is postable; this release is ${this._props.status}`, {
        status: this._props.status,
      });
    }
  }

  get props(): Readonly<RetentionReleaseProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }
}

// ---- helpers -------------------------------------------------------------------------------------

function round4(d: Decimal): Decimal {
  return d.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

function toDecimal(value: Decimal | string | number | null | undefined, field: string): Decimal {
  if (value === null || value === undefined || value === '') {
    throw new ValidationError(`${field} is required`, { field });
  }
  let d: Decimal;
  try {
    d = value instanceof Decimal ? value : new Decimal(value);
  } catch {
    throw new ValidationError(`${field} is not a valid number`, { field, value: String(value) });
  }
  if (!d.isFinite()) throw new ValidationError(`${field} must be a finite number`, { field });
  return d;
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}
