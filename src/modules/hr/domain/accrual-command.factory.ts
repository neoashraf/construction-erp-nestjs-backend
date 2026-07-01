/**
 * buildAccrualCommand — the ONLY place the daily-labour Dr/Cr mapping lives (PURE — turns a set of
 * confirmed daily-labour rows into a balanced DAILY_LABOUR_ACCRUAL PostingCommand). Mirrors the HR design
 * §4(a) worked template line-for-line:
 *   per cost line (one per confirmed entry):  Dr Labour Cost   [project + cost_centre + purpose]  = cost
 *   per payable line (one per confirmed entry): Cr Labour Payable [project + cost_centre + purpose] = cost
 * where cost = headCount × dailyRate (exact Decimal, 4dp). Every line carries project + cost_centre +
 * purpose (no godown — HR is non-inventory); labour-payable is an AGGREGATE liability in Phase 1, so NO
 * party (design §4 / §10 open question). Σdebit = Σcredit by construction (LED re-validates + the deferred
 * DB trigger backstops at commit). accountType hints let LED's TagMatrix apply the §5.1 rules without a
 * lookup. This brief confirms ONE row per call (mirrors the API `.../:id/confirm`), but the factory accepts
 * many so a multi-cost-centre entry (design §4(a): Slab + Brickwork) posts as one balanced entry.
 */
import { Money } from '../../../common/money';
import { PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { AttendanceRecord, ATTENDANCE_SOURCE_TYPE } from './attendance-record';

/** The two resolved HR accrual posting-account ids (MAS), injected per company. */
export interface AccrualAccountMap {
  labourCost: string;
  labourPayable: string;
}

/** A confirmed daily-labour cost line (project + cost centre + purpose all required for the accrual). */
export interface AccrualLineInput {
  projectId: string;
  costCentreId: string;
  purposeId: string;
  cost: Money;
  narration?: string | null;
}

export interface BuildAccrualInput {
  companyId: string;
  financialYearId: string;
  accrualDate: string; // 'YYYY-MM-DD' — the confirmation/attendance date
  sourceId: string; // the attendance row id (or run id)
  postedBy: string;
  narration?: string | null;
  lines: AccrualLineInput[];
}

/** Build the balanced DAILY_LABOUR_ACCRUAL command from the confirmed cost lines. */
export function buildAccrualCommand(input: BuildAccrualInput, accounts: AccrualAccountMap): PostingCommand {
  if (input.lines.length === 0) {
    throw new Error('buildAccrualCommand requires at least one cost line');
  }

  const lines: PostingLine[] = [];
  for (const l of input.lines) {
    const dims = { projectId: l.projectId, costCentreId: l.costCentreId, purposeId: l.purposeId };
    // Dr Labour Cost — the expense hits project P&L now, tagged project + cost_centre + purpose.
    lines.push({
      accountId: accounts.labourCost,
      ...dims,
      debit: l.cost,
      credit: Money.zero(),
      narration: l.narration ?? undefined,
      accountType: 'EXPENSE',
      isControlAccount: false,
    });
    // Cr Labour Payable — the liability outstanding until PAY settles it (aggregate, no party in Phase 1).
    lines.push({
      accountId: accounts.labourPayable,
      ...dims,
      debit: Money.zero(),
      credit: l.cost,
      narration: l.narration ?? undefined,
      accountType: 'LIABILITY',
      isControlAccount: false,
    });
  }

  return {
    companyId: input.companyId,
    financialYearId: input.financialYearId,
    voucherType: 'DAILY_LABOUR_ACCRUAL',
    voucherDate: input.accrualDate,
    sourceType: ATTENDANCE_SOURCE_TYPE,
    sourceId: input.sourceId,
    postedBy: input.postedBy,
    narration: input.narration ?? undefined,
    lines,
  };
}

/** Convenience: build the single-entry accrual command from one confirmed DAILY_LABOUR AttendanceRecord. */
export function accrualLineFor(rec: AttendanceRecord): AccrualLineInput {
  const p = rec.props;
  return {
    projectId: p.projectId,
    costCentreId: p.costCentreId as string,
    purposeId: p.purposeId as string,
    cost: rec.accruedCost(),
    narration: p.labourCategory ? `Daily labour — ${p.labourCategory}` : undefined,
  };
}
