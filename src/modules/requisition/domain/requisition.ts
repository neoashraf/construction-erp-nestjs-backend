/**
 * Requisition aggregate root (PURE — no NestJS/TypeORM). The material-request document (header + lines +
 * approvals) with the `DRAFT → SUBMITTED → APPROVED/REJECTED → PARTIALLY_ISSUED → ISSUED/CLOSED` lifecycle
 * (design §2.1/§3). It OWNS structure + lifecycle + balance arithmetic:
 *   - ≥1 line, each requestedQuantity > 0, priority valid (FR-REQ-001/-004);
 *   - the balance invariant per line: issued + balance = requested, balance ≥ 0 (FR-REQ-018);
 *   - the legal transitions, escalate-by-default enforced by the use case via the approval-policy.
 *
 * It does NOT know on-hand stock, the period, project status, the tag matrix, numbering, valuation, or the
 * threshold value — those are application-orchestrated via ports (design §2.1). THIS brief (workflow) does
 * NOT touch the ledger and moves NO stock: `applyIssue`/`reverseIssue` (the issue mutations) are declared
 * for the aggregate's balance arithmetic but the issue write path itself is brief 2 (#23). Quantities are
 * exact Decimal, stored numeric(18,4) — reconciles to INV/LED, never float.
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import {
  InvalidRequisitionTransitionError,
  IssueExceedsBalanceError,
  MissingRejectReasonError,
  NoOutstandingBalanceError,
  RequisitionNotApprovedError,
  RequisitionNotDraftError,
  RequisitionNotSubmittedError,
} from './errors';
import { RequisitionApproval } from './requisition-approval';
import {
  ApprovalTier,
  ISSUABLE_STATUSES,
  PRIORITIES,
  Priority,
  RequisitionStatus,
} from './requisition-status';

const QTY_SCALE = 4;

/** A line the caller supplies to build/edit a draft. */
export interface NewRequisitionLine {
  itemId: string;
  requestedQuantity: Decimal | string | number;
  uom: string;
}

/** Header + lines the caller supplies to build a draft. */
export interface NewRequisition {
  projectId: string;
  costCentreId: string;
  purposeId: string;
  fromGodownId: string | null;
  requiredDate: string; // 'YYYY-MM-DD'
  priority: Priority;
  narration?: string | null;
  lines: NewRequisitionLine[];
}

/** A PATCH: any header field, or a full replacement of the lines. Omitted fields keep the current value. */
export interface EditRequisition {
  projectId?: string;
  costCentreId?: string;
  purposeId?: string;
  fromGodownId?: string | null;
  requiredDate?: string;
  priority?: Priority;
  narration?: string | null;
  lines?: NewRequisitionLine[];
}

export interface RequisitionLineProps {
  id: string;
  lineNo: number;
  itemId: string;
  requestedQuantity: Decimal;
  issuedQuantity: Decimal;
  balanceQuantity: Decimal;
  indicativeRate: Decimal | null;
  uom: string;
}

export interface RequisitionProps {
  companyId: string;
  financialYearId: string;
  requisitionNo: string | null;
  requisitionSeq: number | null;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  fromGodownId: string | null;
  requiredDate: string;
  priority: Priority;
  status: RequisitionStatus;
  estimatedValue: Decimal;
  approvalTier: ApprovalTier | null;
  submittedAt: Date | null;
  submittedById: string | null;
  closedAt: Date | null;
  closedReason: string | null;
  narration: string | null;
  version: number;
  lines: RequisitionLineProps[];
}

/** The estimate input the use case supplies at submit — per-line indicative rate (INV port). */
export interface LineEstimate {
  lineId: string;
  indicativeRate: Decimal;
}

/** One approval to record (approve/reject). */
export interface ApprovalInput {
  id: string;
  decision: 'APPROVED' | 'REJECTED';
  tier: ApprovalTier;
  thresholdEvaluated: Decimal;
  estimatedValue: Decimal;
  reason: string | null;
  decidedBy: string;
}

export class Requisition extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: RequisitionProps,
    private _approvals: RequisitionApproval[] = [],
  ) {
    super(id);
  }

  /**
   * Build a DRAFT. Enforces ≥1 line, requestedQuantity > 0 per line, a valid priority; at draft each
   * line's issuedQuantity = 0 and balanceQuantity = requestedQuantity (FR-REQ-001/-004/-018). No number,
   * no ledger impact, no stock.
   */
  static createDraft(
    id: string,
    companyId: string,
    financialYearId: string,
    input: NewRequisition,
    lineIds: string[],
  ): Requisition {
    const lines = Requisition.buildLines(input.lines, lineIds);
    return new Requisition(id, {
      companyId,
      financialYearId,
      requisitionNo: null,
      requisitionSeq: null,
      projectId: req(input.projectId, 'projectId'),
      costCentreId: req(input.costCentreId, 'costCentreId'),
      purposeId: req(input.purposeId, 'purposeId'),
      fromGodownId: trimOrNull(input.fromGodownId),
      requiredDate: req(input.requiredDate, 'requiredDate'),
      priority: assertPriority(input.priority),
      status: 'DRAFT',
      estimatedValue: new Decimal(0),
      approvalTier: null,
      submittedAt: null,
      submittedById: null,
      closedAt: null,
      closedReason: null,
      narration: input.narration ?? null,
      version: 1,
      lines,
    });
  }

  static rehydrate(id: string, props: RequisitionProps, approvals: RequisitionApproval[] = []): Requisition {
    return new Requisition(id, props, approvals);
  }

  /** Edit the draft in place (only while DRAFT — FR-REQ-022, edge 6). Replacing lines re-validates them. */
  editDraft(patch: EditRequisition, lineIds: string[]): void {
    this.assertDraft();
    const p = this._props;
    if (patch.projectId !== undefined) p.projectId = req(patch.projectId, 'projectId');
    if (patch.costCentreId !== undefined) p.costCentreId = req(patch.costCentreId, 'costCentreId');
    if (patch.purposeId !== undefined) p.purposeId = req(patch.purposeId, 'purposeId');
    if (patch.fromGodownId !== undefined) p.fromGodownId = trimOrNull(patch.fromGodownId);
    if (patch.requiredDate !== undefined) p.requiredDate = req(patch.requiredDate, 'requiredDate');
    if (patch.priority !== undefined) p.priority = assertPriority(patch.priority);
    if (patch.narration !== undefined) p.narration = patch.narration ?? null;
    if (patch.lines !== undefined) p.lines = Requisition.buildLines(patch.lines, lineIds);
  }

  /**
   * Submit a DRAFT for review: stamp the estimated value + selected tier + requisitionNo + submittedAt/by,
   * record each line's indicative rate, → SUBMITTED (FR-REQ-005/-006/-009). No stock, posts nothing.
   */
  submit(
    requisitionNo: string,
    requisitionSeq: number,
    estimatedValue: Decimal,
    tier: ApprovalTier,
    lineEstimates: LineEstimate[],
    actor: string,
    at: Date,
  ): void {
    if (this._props.status !== 'DRAFT') {
      throw new InvalidRequisitionTransitionError(this._props.status, 'submit');
    }
    const rates = new Map(lineEstimates.map((e) => [e.lineId, e.indicativeRate]));
    for (const line of this._props.lines) {
      const rate = rates.get(line.id);
      if (rate !== undefined) line.indicativeRate = rate;
    }
    this._props.requisitionNo = req(requisitionNo, 'requisitionNo');
    this._props.requisitionSeq = requisitionSeq;
    this._props.estimatedValue = estimatedValue;
    this._props.approvalTier = tier;
    this._props.submittedById = actor;
    this._props.submittedAt = at;
    this._props.status = 'SUBMITTED';
  }

  /** Record an approval and move to APPROVED. Only from SUBMITTED (FR-REQ-008). No stock, posts nothing. */
  approve(input: ApprovalInput, at: Date): void {
    this.assertSubmitted();
    this.recordApproval({ ...input, decision: 'APPROVED', reason: input.reason }, at);
    this._props.status = 'APPROVED';
  }

  /**
   * Record a rejection (mandatory reason) and move to REJECTED. Only from SUBMITTED (FR-REQ-008, edge 7).
   * Returns the requisition to the requester. No stock, posts nothing.
   */
  reject(input: ApprovalInput, at: Date): void {
    this.assertSubmitted();
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new MissingRejectReasonError();
    this.recordApproval({ ...input, decision: 'REJECTED', reason }, at);
    this._props.status = 'REJECTED';
  }

  /**
   * Manually close an APPROVED/PARTIALLY_ISSUED requisition with outstanding balance → CLOSED, abandoning
   * the remaining balance (FR-REQ-020, edge 15). No further issue allowed, NO ledger effect. A fully-issued
   * requisition (ISSUED, no balance) → NoOutstandingBalanceError.
   */
  close(reason: string, at: Date): void {
    const s = this._props.status;
    if (s === 'ISSUED' || !this.hasOutstanding()) {
      throw new NoOutstandingBalanceError(s);
    }
    if (s !== 'APPROVED' && s !== 'PARTIALLY_ISSUED') {
      throw new InvalidRequisitionTransitionError(s, 'close');
    }
    this._props.status = 'CLOSED';
    this._props.closedReason = (reason ?? '').trim() || null;
    this._props.closedAt = at;
  }

  /** status ∈ {APPROVED, PARTIALLY_ISSUED} else throw (FR-REQ-012). Used by brief 2's issue. */
  assertIssuable(): void {
    if (!ISSUABLE_STATUSES.includes(this._props.status)) {
      throw new RequisitionNotApprovedError(this._props.status);
    }
  }

  /**
   * Apply one issue to a set of lines: for each, decrement the balance by the issued qty (0 < qty ≤ balance)
   * and accrue issuedQuantity, then recompute status (PARTIALLY_ISSUED while any positive balance remains,
   * ISSUED when all zero) (FR-REQ-018/-019). BALANCE ARITHMETIC ONLY — the movement + ledger write is brief
   * 2 (#23); this brief never calls it. Kept here so the aggregate owns the invariant.
   */
  applyIssue(lines: { lineId: string; issueQuantity: Decimal }[]): void {
    this.assertIssuable();
    for (const { lineId, issueQuantity } of lines) {
      const line = this.lineOrThrow(lineId);
      const qty = round(issueQuantity);
      if (!qty.greaterThan(0) || qty.greaterThan(line.balanceQuantity)) {
        throw new IssueExceedsBalanceError(qty.toFixed(QTY_SCALE), line.balanceQuantity.toFixed(QTY_SCALE));
      }
      line.issuedQuantity = round(line.issuedQuantity.plus(qty));
      line.balanceQuantity = round(line.requestedQuantity.minus(line.issuedQuantity));
    }
    this._props.status = this.isFullyIssued() ? 'ISSUED' : 'PARTIALLY_ISSUED';
  }

  /**
   * Reverse a prior issue's quantities: restore the affected lines' issued/balance and recompute status
   * (ISSUED → PARTIALLY_ISSUED, or → APPROVED when all issues reversed) (FR-REQ-017). BALANCE ARITHMETIC
   * ONLY — the INV mirror movement + LED reversal is brief 2 (#23).
   */
  reverseIssue(lines: { lineId: string; issuedQuantity: Decimal }[]): void {
    for (const { lineId, issuedQuantity } of lines) {
      const line = this.lineOrThrow(lineId);
      line.issuedQuantity = round(line.issuedQuantity.minus(round(issuedQuantity)));
      if (line.issuedQuantity.isNegative()) line.issuedQuantity = new Decimal(0);
      line.balanceQuantity = round(line.requestedQuantity.minus(line.issuedQuantity));
    }
    this._props.status = this.anyIssued() ? 'PARTIALLY_ISSUED' : 'APPROVED';
  }

  /** Per-line remaining balance (FR-REQ-021). */
  outstanding(): { lineId: string; balance: Decimal }[] {
    return this._props.lines.map((l) => ({ lineId: l.id, balance: l.balanceQuantity }));
  }

  /** Σ(balanceQuantity × indicativeRate) — informational outstanding value (FR-REQ-021). */
  outstandingValueIndicative(): Decimal {
    return this._props.lines.reduce(
      (acc, l) => acc.plus(l.balanceQuantity.times(l.indicativeRate ?? 0)),
      new Decimal(0),
    );
  }

  /** Every line fully issued (balance 0) — the ISSUED terminal condition. */
  isFullyIssued(): boolean {
    return this._props.lines.every((l) => l.balanceQuantity.isZero());
  }

  private anyIssued(): boolean {
    return this._props.lines.some((l) => l.issuedQuantity.greaterThan(0));
  }

  /** Any line with a positive balance — the "has outstanding" close precondition. */
  hasOutstanding(): boolean {
    return this._props.lines.some((l) => l.balanceQuantity.greaterThan(0));
  }

  assertSubmitted(): void {
    if (this._props.status !== 'SUBMITTED') throw new RequisitionNotSubmittedError(this._props.status);
  }

  private assertDraft(): void {
    if (this._props.status !== 'DRAFT') throw new RequisitionNotDraftError(this._props.status);
  }

  private recordApproval(input: ApprovalInput, at: Date): void {
    this._approvals.push(
      RequisitionApproval.of({
        id: input.id,
        requisitionId: this.id,
        decision: input.decision,
        tier: input.tier,
        thresholdEvaluated: input.thresholdEvaluated,
        estimatedValueAtReview: input.estimatedValue,
        reason: input.reason,
        decidedBy: input.decidedBy,
        decidedAt: at,
      }),
    );
  }

  private lineOrThrow(lineId: string): RequisitionLineProps {
    const line = this._props.lines.find((l) => l.id === lineId);
    if (!line) throw new ValidationError(`Requisition line ${lineId} not found`, { lineId });
    return line;
  }

  get props(): Readonly<RequisitionProps> {
    return this._props;
  }
  get approvals(): readonly RequisitionApproval[] {
    return this._approvals;
  }
  get version(): number {
    return this._props.version;
  }

  private static buildLines(input: NewRequisitionLine[], lineIds: string[]): RequisitionLineProps[] {
    if (!input || input.length === 0) {
      throw new ValidationError('A requisition requires at least one line', { field: 'lines' });
    }
    if (lineIds.length < input.length) {
      throw new ValidationError('Not enough generated ids for the requisition lines', { field: 'lines' });
    }
    return input.map((l, i) => {
      const requested = round(toDecimal(l.requestedQuantity, 'requestedQuantity'));
      if (!requested.greaterThan(0)) {
        throw new ValidationError('requestedQuantity must be > 0', {
          field: 'requestedQuantity',
          value: requested.toString(),
        });
      }
      return {
        id: lineIds[i],
        lineNo: i + 1,
        itemId: req(l.itemId, 'itemId'),
        requestedQuantity: requested,
        issuedQuantity: new Decimal(0),
        balanceQuantity: requested,
        indicativeRate: null,
        uom: req(l.uom, 'uom'),
      };
    });
  }
}

// ---- helpers -------------------------------------------------------------------------------------

function round(d: Decimal): Decimal {
  return d.toDecimalPlaces(QTY_SCALE, Decimal.ROUND_HALF_UP);
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

function trimOrNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t || null;
}

function assertPriority(p: Priority): Priority {
  if (!PRIORITIES.includes(p)) {
    throw new ValidationError(`priority must be one of ${PRIORITIES.join(', ')}`, { priority: p });
  }
  return p;
}
