/**
 * PurchaseOrder aggregate (PURE — no NestJS/TypeORM). A NON-POSTING commitment document: writes no ledger
 * line, draws no `PURCHASE` number (FR-PUR-001). Lifecycle `DRAFT -> APPROVED -> PARTIALLY_BILLED /
 * PARTIALLY_RECEIVED -> CLOSED`, with `CANCELLED` reachable from DRAFT/APPROVED before any bill is raised
 * (FR-PUR-002). Each line carries the four dimensions (project + cost_centre + purpose + godown) so the
 * commitment is dimensioned, even though it posts nothing (FR-PUR-001). `openQtyOf` supports bill/GRN
 * line-defaulting from the PO's open (unbilled) lines (FR-PUR-003).
 */
import Decimal from 'decimal.js';
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { InvalidPoTransitionError, PoNotBillableError } from './errors';

export type PoStatus =
  | 'DRAFT'
  | 'APPROVED'
  | 'PARTIALLY_BILLED'
  | 'PARTIALLY_RECEIVED'
  | 'CLOSED'
  | 'CANCELLED';
export const PO_STATUSES: readonly PoStatus[] = [
  'DRAFT',
  'APPROVED',
  'PARTIALLY_BILLED',
  'PARTIALLY_RECEIVED',
  'CLOSED',
  'CANCELLED',
] as const;

/** A PO status a bill/GRN may be raised against (FR-PUR-002). */
const BILLABLE_STATUSES: readonly PoStatus[] = ['APPROVED', 'PARTIALLY_BILLED', 'PARTIALLY_RECEIVED'];

export interface NewPurchaseOrderLine {
  itemId: string;
  orderedQty: Decimal | string | number;
  rate: Decimal | string | number;
  godownId: string;
  projectId: string;
  costCentreId: string;
  purposeId: string;
}

export interface PurchaseOrderLineProps {
  id: string;
  lineNo: number;
  itemId: string;
  orderedQty: Decimal;
  rate: Decimal;
  lineAmount: Decimal;
  godownId: string;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  billedQty: Decimal;
  receivedQty: Decimal;
}

export interface NewPurchaseOrder {
  projectId: string;
  supplierId: string;
  poRefNo: string | null;
  poDate: string; // 'YYYY-MM-DD'
  expectedDeliveryDate: string | null;
  narration?: string | null;
  lines: NewPurchaseOrderLine[];
}

export type PoPatch = Partial<Omit<NewPurchaseOrder, 'lines'>> & { lines?: NewPurchaseOrderLine[] };

export interface PurchaseOrderProps {
  companyId: string;
  financialYearId: string;
  projectId: string;
  supplierId: string;
  poRefNo: string | null;
  poDate: string;
  expectedDeliveryDate: string | null;
  status: PoStatus;
  narration: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  version: number;
}

export class PurchaseOrder extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: PurchaseOrderProps,
    private _lines: PurchaseOrderLineProps[],
  ) {
    super(id);
  }

  static createDraft(
    id: string,
    companyId: string,
    financialYearId: string,
    input: NewPurchaseOrder,
    lineIds: string[],
  ): PurchaseOrder {
    const lines = buildLines(input.lines, lineIds);
    return new PurchaseOrder(
      id,
      {
        companyId,
        financialYearId,
        projectId: req(input.projectId, 'projectId'),
        supplierId: req(input.supplierId, 'supplierId'),
        poRefNo: input.poRefNo ?? null,
        poDate: req(input.poDate, 'poDate'),
        expectedDeliveryDate: input.expectedDeliveryDate ?? null,
        status: 'DRAFT',
        narration: input.narration ?? null,
        approvedBy: null,
        approvedAt: null,
        version: 1,
      },
      lines,
    );
  }

  static rehydrate(id: string, props: PurchaseOrderProps, lines: PurchaseOrderLineProps[]): PurchaseOrder {
    return new PurchaseOrder(id, props, lines);
  }

  /** Edit while DRAFT only (FR-PUR-024). Lines, if supplied, replace the set wholesale (no billed/received yet). */
  editDraft(patch: PoPatch, lineIds: string[]): void {
    this.assertDraft();
    const p = this._props;
    p.projectId = patch.projectId !== undefined ? req(patch.projectId, 'projectId') : p.projectId;
    p.supplierId = patch.supplierId !== undefined ? req(patch.supplierId, 'supplierId') : p.supplierId;
    p.poRefNo = patch.poRefNo !== undefined ? patch.poRefNo : p.poRefNo;
    p.poDate = patch.poDate !== undefined ? req(patch.poDate, 'poDate') : p.poDate;
    p.expectedDeliveryDate =
      patch.expectedDeliveryDate !== undefined ? patch.expectedDeliveryDate : p.expectedDeliveryDate;
    p.narration = patch.narration !== undefined ? patch.narration : p.narration;
    if (patch.lines !== undefined) {
      this._lines = buildLines(patch.lines, lineIds);
    }
  }

  /** DRAFT -> APPROVED. Writes NO ledger line, draws NO PURCHASE number (FR-PUR-002). */
  approve(by: string, at: Date): void {
    if (this._props.status !== 'DRAFT') {
      throw new InvalidPoTransitionError(this._props.status, 'approve');
    }
    this._props.status = 'APPROVED';
    this._props.approvedBy = by;
    this._props.approvedAt = at;
  }

  /** DRAFT/APPROVED -> CANCELLED, only before any bill is raised against this PO (checked by the use case). */
  cancel(): void {
    if (this._props.status !== 'DRAFT' && this._props.status !== 'APPROVED') {
      throw new InvalidPoTransitionError(this._props.status, 'cancel');
    }
    this._props.status = 'CANCELLED';
  }

  /** A bill/GRN may be raised only against APPROVED/PARTIALLY_BILLED/PARTIALLY_RECEIVED (FR-PUR-002). */
  assertBillable(): void {
    if (!BILLABLE_STATUSES.includes(this._props.status)) {
      throw new PoNotBillableError(this._props.status);
    }
  }

  /** ordered − billed, for bill/GRN line defaulting (FR-PUR-003). */
  openQtyOf(lineNo: number): Decimal {
    const line = this._lines.find((l) => l.lineNo === lineNo);
    if (!line) throw new ValidationError(`PO line ${lineNo} not found`, { lineNo });
    return line.orderedQty.minus(line.billedQty);
  }

  /** Record a bill applying billedQty to this PO's line (called by the bill's create/post use case). */
  applyBilledQty(lineNo: number, billedQty: Decimal): void {
    const line = this._lines.find((l) => l.lineNo === lineNo);
    if (!line) throw new ValidationError(`PO line ${lineNo} not found`, { lineNo });
    line.billedQty = line.billedQty.plus(billedQty);
    this.recomputeStatus();
  }

  private recomputeStatus(): void {
    if (this._props.status !== 'APPROVED' && this._props.status !== 'PARTIALLY_BILLED') return;
    const fullyBilled = this._lines.every((l) => l.billedQty.greaterThanOrEqualTo(l.orderedQty));
    this._props.status = fullyBilled ? 'CLOSED' : 'PARTIALLY_BILLED';
  }

  private assertDraft(): void {
    if (this._props.status !== 'DRAFT') {
      throw new InvalidPoTransitionError(this._props.status, 'edit');
    }
  }

  get props(): Readonly<PurchaseOrderProps> {
    return this._props;
  }
  get lines(): readonly PurchaseOrderLineProps[] {
    return this._lines;
  }
  get version(): number {
    return this._props.version;
  }
}

function buildLines(input: NewPurchaseOrderLine[], ids: string[]): PurchaseOrderLineProps[] {
  if (!input?.length) {
    throw new ValidationError('A Purchase Order requires at least one line', { field: 'lines' });
  }
  return input.map((l, i) => {
    const orderedQty = toDecimal(l.orderedQty, 'orderedQty');
    if (!orderedQty.greaterThan(0)) {
      throw new ValidationError('orderedQty must be > 0', { lineNo: i + 1, orderedQty: orderedQty.toString() });
    }
    const rate = assertNonNeg(toDecimal(l.rate, 'rate'), 'rate');
    return {
      id: ids[i],
      lineNo: i + 1,
      itemId: req(l.itemId, 'itemId'),
      orderedQty,
      rate,
      lineAmount: round4(orderedQty.times(rate)),
      godownId: req(l.godownId, 'godownId'),
      projectId: req(l.projectId, 'projectId'),
      costCentreId: req(l.costCentreId, 'costCentreId'),
      purposeId: req(l.purposeId, 'purposeId'),
      billedQty: new Decimal(0),
      receivedQty: new Decimal(0),
    };
  });
}

function round4(d: Decimal): Decimal {
  return d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
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

function assertNonNeg(d: Decimal, field: string): Decimal {
  if (d.isNegative()) throw new ValidationError(`${field} must be >= 0`, { field });
  return d;
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}
