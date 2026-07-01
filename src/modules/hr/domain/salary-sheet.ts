/**
 * SalarySheet aggregate + SalarySheetLine (PURE — no NestJS/TypeORM). The office-staff payroll run for one
 * period: DRAFT (editable, per-line/bulk component edits, re-totalled) → POSTED (one SALARY entry,
 * immutable) → REVERSED (DERIVED — see below). Mirrors design §2.2/§3.
 *
 *   generate()        — build a DRAFT sheet from a caller-supplied set of calculated lines (one per active
 *                        employee for the period; INACTIVE exclusion happens upstream in salary.service).
 *   editLine()         — per-employee component edit on a DRAFT line; recomputes that line's net + the
 *                        sheet totals (FR-HR-014).
 *   applyBulkComponents() — apply a component patch (optionally scoped to a subset of employeeIds) across
 *                        DRAFT lines; recomputes totals.
 *   assertPostable()/markPosted() — the ONE ledger-touching transition (design §3); salary.service builds
 *                        the SALARY command and calls PostingService, then calls markPosted(entry.id).
 *
 * `status` is stored as DRAFT|POSTED only — SalarySheet NEVER stores a 'REVERSED' value (design §3's
 * SalarySheet table row: "REVERSED (derived) | no | reversal entry exists | original retained"). Whether a
 * posted sheet has been reversed is answered by querying LED for a journal_entry with
 * reversal_of = salary_entry_id — the application/read layer computes the DERIVED status shown to callers,
 * never this aggregate. This is a deliberate design choice, stricter than other modules' stored-CANCELLED
 * convention — do not "fix" it by adding a REVERSED literal here.
 */
import { AggregateRoot } from '../../../common/domain/domain';
import { ValidationError } from '../../../common/errors/domain-error';
import { Money } from '../../../common/money';
import { applyComponents, PayComponents, SalaryLineAmounts } from './salary-calculator';
import { SalaryNotDraftError } from './errors';

export const SALARY_SHEET_SOURCE_TYPE = 'SalarySheet';

/** Stored status — DRAFT while editable, POSTED once the SALARY entry exists. REVERSED is derived, never stored. */
export type SalarySheetStatus = 'DRAFT' | 'POSTED';
export const SALARY_SHEET_STATUSES: readonly SalarySheetStatus[] = ['DRAFT', 'POSTED'] as const;

export interface NewSalarySheetLine {
  employeeId: string;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  paidDays: Money | string | number;
  gross: Money;
  components?: PayComponents;
}

export interface SalarySheetLineProps {
  employeeId: string;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  paidDays: Money;
  grossAmount: Money;
  allowances: Money;
  tds: Money;
  pf: Money;
  advanceRecovery: Money;
  otherDeductions: Money;
  netAmount: Money;
  version: number;
}

/** A PATCH of the editable component fields of one DRAFT line (FR-HR-014). */
export interface EditSalaryLineComponents {
  allowances?: Money | string | number;
  tds?: Money | string | number;
  pf?: Money | string | number;
  advanceRecovery?: Money | string | number;
  otherDeductions?: Money | string | number;
}

/** Bulk-apply input: a component patch, optionally restricted to a subset of employeeIds (design §5.2 / API contract). */
export interface BulkApplyComponents {
  allowances?: Money | string | number;
  tdsRate?: Money | string | number; // fraction of gross, e.g. 0.05 for 5%
  pf?: Money | string | number;
  advanceRecovery?: Money | string | number;
  employeeIds?: string[];
}

export class SalarySheetLine extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: SalarySheetLineProps,
  ) {
    super(id);
  }

  static create(id: string, input: NewSalarySheetLine): SalarySheetLine {
    const paidDays = input.paidDays instanceof Money ? input.paidDays : Money.of(input.paidDays);
    if (paidDays.isNegative()) throw new ValidationError('paidDays must be >= 0', { field: 'paidDays' });
    const amounts = applyComponents(input.gross, input.components ?? {});
    return new SalarySheetLine(id, {
      employeeId: req(input.employeeId, 'employeeId'),
      projectId: req(input.projectId, 'projectId'),
      costCentreId: req(input.costCentreId, 'costCentreId'),
      purposeId: req(input.purposeId, 'purposeId'),
      paidDays,
      grossAmount: amounts.gross,
      allowances: amounts.allowances,
      tds: amounts.tds,
      pf: amounts.pf,
      advanceRecovery: amounts.advanceRecovery,
      otherDeductions: amounts.other,
      netAmount: amounts.net,
      version: 1,
    });
  }

  static rehydrate(id: string, props: SalarySheetLineProps): SalarySheetLine {
    return new SalarySheetLine(id, props);
  }

  /** Recompute this line's deduction/allowance figures + net from a component PATCH (FR-HR-014). */
  editComponents(patch: EditSalaryLineComponents): void {
    const p = this._props;
    const amounts = applyComponents(p.grossAmount, {
      allowances: patch.allowances !== undefined ? patch.allowances : p.allowances,
      tds: patch.tds !== undefined ? patch.tds : p.tds,
      pf: patch.pf !== undefined ? patch.pf : p.pf,
      advanceRecovery: patch.advanceRecovery !== undefined ? patch.advanceRecovery : p.advanceRecovery,
      other: patch.otherDeductions !== undefined ? patch.otherDeductions : p.otherDeductions,
    });
    p.allowances = amounts.allowances;
    p.tds = amounts.tds;
    p.pf = amounts.pf;
    p.advanceRecovery = amounts.advanceRecovery;
    p.otherDeductions = amounts.other;
    p.netAmount = amounts.net;
  }

  /** Apply a bulk-component rule to this line: flat allowance/pf/advance + a TDS RATE off gross. */
  applyBulk(rule: BulkApplyComponents): void {
    const p = this._props;
    const amounts: SalaryLineAmounts = applyComponents(p.grossAmount, {
      allowances: rule.allowances !== undefined ? rule.allowances : p.allowances,
      tds: rule.tdsRate !== undefined ? p.grossAmount.times(toDecimalLike(rule.tdsRate)).round() : p.tds,
      pf: rule.pf !== undefined ? rule.pf : p.pf,
      advanceRecovery: rule.advanceRecovery !== undefined ? rule.advanceRecovery : p.advanceRecovery,
      other: p.otherDeductions,
    });
    p.allowances = amounts.allowances;
    p.tds = amounts.tds;
    p.pf = amounts.pf;
    p.advanceRecovery = amounts.advanceRecovery;
    p.otherDeductions = amounts.other;
    p.netAmount = amounts.net;
  }

  get props(): Readonly<SalarySheetLineProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }
}

export interface NewSalarySheet {
  financialYearId: string;
  periodLabel: string;
  periodStart: string; // 'YYYY-MM-DD'
  periodEnd: string;
}

export interface SalarySheetProps {
  companyId: string;
  financialYearId: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  status: SalarySheetStatus;
  salaryEntryId: string | null;
  postedAt: Date | null;
  postedBy: string | null;
  version: number;
}

export class SalarySheet extends AggregateRoot<string> {
  private constructor(
    id: string,
    private _props: SalarySheetProps,
    private _lines: SalarySheetLine[],
  ) {
    super(id);
  }

  /** Build a DRAFT sheet for a period from the caller-supplied, already-calculated lines (design §5.2). */
  static generate(
    id: string,
    companyId: string,
    input: NewSalarySheet,
    lines: SalarySheetLine[],
  ): SalarySheet {
    if (input.periodEnd < input.periodStart) {
      throw new ValidationError('periodEnd must be >= periodStart', {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      });
    }
    return new SalarySheet(
      id,
      {
        companyId,
        financialYearId: req(input.financialYearId, 'financialYearId'),
        periodLabel: req(input.periodLabel, 'periodLabel'),
        periodStart: req(input.periodStart, 'periodStart'),
        periodEnd: req(input.periodEnd, 'periodEnd'),
        status: 'DRAFT',
        salaryEntryId: null,
        postedAt: null,
        postedBy: null,
        version: 1,
      },
      lines,
    );
  }

  static rehydrate(id: string, props: SalarySheetProps, lines: SalarySheetLine[]): SalarySheet {
    return new SalarySheet(id, props, lines);
  }

  /** Edit one line's components (DRAFT only — FR-HR-014). Throws SalaryNotDraftError once posted. */
  editLine(lineId: string, patch: EditSalaryLineComponents): SalarySheetLine {
    this.assertDraft();
    const line = this.requireLine(lineId);
    line.editComponents(patch);
    return line;
  }

  /** Bulk-apply a component rule across all lines, or a subset by employeeId (DRAFT only — FR-HR-014). */
  applyBulkComponents(rule: BulkApplyComponents): void {
    this.assertDraft();
    const targets = rule.employeeIds?.length
      ? this._lines.filter((l) => rule.employeeIds!.includes(l.props.employeeId))
      : this._lines;
    for (const line of targets) line.applyBulk(rule);
  }

  assertPostable(): void {
    this.assertDraft();
  }

  /** DRAFT → POSTED, recording the SALARY journal entry id (design §3). */
  markPosted(entryId: string, by: string, at: Date): void {
    this.assertDraft();
    this._props.status = 'POSTED';
    this._props.salaryEntryId = req(entryId, 'entryId');
    this._props.postedBy = by;
    this._props.postedAt = at;
  }

  private assertDraft(): void {
    if (this._props.status !== 'DRAFT') throw new SalaryNotDraftError(this.id);
  }

  private requireLine(lineId: string): SalarySheetLine {
    const line = this._lines.find((l) => l.id === lineId);
    if (!line) throw new ValidationError(`Salary sheet line ${lineId} not found`, { lineId });
    return line;
  }

  /** Σ gross / Σ deductions (tds+pf+advance+other, allowances excluded) / Σ net across all lines. */
  totals(): { gross: Money; deductions: Money; net: Money } {
    let gross = Money.zero();
    let deductions = Money.zero();
    let net = Money.zero();
    for (const line of this._lines) {
      const p = line.props;
      gross = gross.plus(p.grossAmount);
      deductions = deductions.plus(p.tds).plus(p.pf).plus(p.advanceRecovery).plus(p.otherDeductions);
      net = net.plus(p.netAmount);
    }
    return { gross, deductions, net };
  }

  get props(): Readonly<SalarySheetProps> {
    return this._props;
  }
  get lines(): readonly SalarySheetLine[] {
    return this._lines;
  }
  get version(): number {
    return this._props.version;
  }
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}

function toDecimalLike(v: Money | string | number) {
  return v instanceof Money ? v.amount : v;
}
