/**
 * RequisitionIssue + RequisitionIssueLine (PURE — no NestJS/TypeORM). One issue event against a
 * requisition (SRS §8, design §3.2): a Store Keeper releases material (full or partial), INV values +
 * deducts stock via `issueOut` per line, and REQ posts ONE consumption `journal_entry` covering every
 * line. Written once at issue; append-only — a correction is `…/issues/:issueId/reverse` (recorded via
 * `reversedAt`/`reversedById`, never edited). Money/qty are exact Decimal (numeric(18,4)).
 */
import Decimal from 'decimal.js';
import { Entity } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { AlreadyReversedIssueError } from './errors';

export interface RequisitionIssueLineProps {
  id: string;
  requisitionIssueId: string;
  requisitionLineId: string;
  itemId: string;
  godownId: string;
  stockMovementId: string;
  issuedQuantity: Decimal;
  rate: Decimal;
  value: Decimal;
}

export interface NewRequisitionIssueLine {
  id: string;
  requisitionLineId: string;
  itemId: string;
  godownId: string;
  stockMovementId: string;
  issuedQuantity: Decimal;
  rate: Decimal;
  value: Decimal;
}

export interface RequisitionIssueProps {
  requisitionId: string;
  issueNo: number;
  fromGodownId: string;
  journalEntryId: string;
  entryNo: string | null;
  issuedValue: Decimal;
  issuedById: string;
  issuedAt: Date;
  negativeStockAuthorisedById: string | null;
  reversedAt: Date | null;
  reversedById: string | null;
}

export class RequisitionIssue extends Entity<string> {
  private constructor(
    id: string,
    private _props: RequisitionIssueProps,
    private readonly _lines: RequisitionIssueLineProps[],
  ) {
    super(id);
  }

  /** Build one issue event covering ≥1 line (FR-REQ-013/-014/-018). No reversal yet. */
  static create(
    id: string,
    requisitionId: string,
    issueNo: number,
    fromGodownId: string,
    journalEntryId: string,
    entryNo: string | null,
    lines: NewRequisitionIssueLine[],
    issuedById: string,
    at: Date,
    negativeStockAuthorisedById: string | null = null,
  ): RequisitionIssue {
    if (!lines.length) {
      throw new ValidationError('A requisition issue requires at least one line', { field: 'lines' });
    }
    const issuedValue = lines.reduce((acc, l) => acc.plus(l.value), new Decimal(0));
    return new RequisitionIssue(
      id,
      {
        requisitionId,
        issueNo,
        fromGodownId,
        journalEntryId,
        entryNo,
        issuedValue,
        issuedById,
        issuedAt: at,
        negativeStockAuthorisedById,
        reversedAt: null,
        reversedById: null,
      },
      lines.map((l) => ({ ...l, requisitionIssueId: id })),
    );
  }

  static rehydrate(
    id: string,
    props: RequisitionIssueProps,
    lines: RequisitionIssueLineProps[],
  ): RequisitionIssue {
    return new RequisitionIssue(id, props, lines);
  }

  /** Only a posted, un-reversed issue may be reversed (FR-REQ-017, edge 12). */
  assertNotReversed(): void {
    if (this._props.reversedAt) throw new AlreadyReversedIssueError(this.id);
  }

  /** Mark this issue reversed (append-only — the original movement/entry/lines are never touched). */
  markReversed(reversedById: string, at: Date): void {
    this.assertNotReversed();
    this._props.reversedAt = at;
    this._props.reversedById = reversedById;
  }

  get props(): Readonly<RequisitionIssueProps> {
    return this._props;
  }
  get lines(): readonly RequisitionIssueLineProps[] {
    return this._lines;
  }
}
