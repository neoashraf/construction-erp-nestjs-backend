/**
 * buildSalaryCommand — the ONLY place the office-staff SALARY Dr/Cr mapping lives (PURE — turns a draft
 * SalarySheet's lines into a balanced SALARY PostingCommand). Mirrors the HR design §4(b) worked template
 * line-for-line:
 *   Dr Gross Salary & Wages          [project + cost_centre(Labour) + purpose]  = Σ gross
 *   Dr Employer PF Contribution      [project + cost_centre(Labour) + purpose]  = Σ employerPf
 *   Cr Salary Payable (liability)    [project + cost_centre(Labour) + purpose]  = Σ (gross − tds − employeePf − advance)
 *   Cr TDS Payable (liability)       [project + cost_centre(Labour) + purpose]  = Σ tds
 *   Cr PF Payable (liability)        [project + cost_centre(Labour) + purpose]  = Σ (employerPf + employeePf)
 *   Cr Staff Advance Recovery (asset, credit reduces the asset) [same dims]     = Σ advanceRecovery
 * where Salary Payable is the NET residual (gross − tds − employeePf − advance; "employee PF" is the
 * SalarySheetLine.pf field), and PF Payable aggregates BOTH the employer contribution (a cost, line 2) and
 * the employee-withheld PF (funded out of what would otherwise be paid in line 3) — design §4(b)'s
 * worked ৳500,000/৳25,000/৳405,000/৳40,000/৳50,000/৳30,000 figures. Every line carries
 * project + cost_centre + purpose (no godown — HR is non-inventory); all payable/deduction lines are
 * AGGREGATE liabilities in Phase 1, so NO party (design §4/§10 open question — mirrors the accrual
 * factory's own no-party default). Σdebit = Σcredit by construction (LED re-validates + the deferred DB
 * trigger backstops at commit). One entry per company/period — every sheet line is aggregated into the
 * SAME six lines when lines share (project, costCentre, purpose); when they differ, lines are emitted per
 * distinct dimension tuple so each cost-tagging group stays separately traceable while the entry remains
 * one balanced whole.
 */
import { Money } from '../../../common/money';
import { PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { SalarySheet, SalarySheetLine } from './salary-sheet';

export const SALARY_SOURCE_TYPE = 'SalarySheet';

/** The six resolved HR salary posting-account ids (MAS) + the Labour cost centre, injected per company. */
export interface SalaryAccountMap {
  grossSalary: string;
  employerPfContribution: string;
  salaryPayable: string;
  tdsPayable: string;
  pfPayable: string;
  staffAdvanceRecovery: string;
  labourCostCentreId: string;
}

export interface BuildSalaryInput {
  companyId: string;
  financialYearId: string;
  voucherDate: string; // 'YYYY-MM-DD' — the post date
  sourceId: string; // the salary sheet id
  postedBy: string;
  narration?: string | null;
  /** Employer PF contribution per line-employee (a cost; keyed by line id). Defaults to 0 if omitted. */
  employerPfByLine?: Map<string, Money> | Record<string, Money>;
}

interface DimGroup {
  projectId: string;
  costCentreId: string;
  purposeId: string;
  gross: Money;
  employerPf: Money;
  tds: Money;
  employeePf: Money;
  advanceRecovery: Money;
  salaryPayable: Money; // gross - tds - employeePf - advanceRecovery for this group (design §4(b))
}

/** Build the balanced SALARY command from a DRAFT sheet's lines. */
export function buildSalaryCommand(
  sheet: SalarySheet,
  accounts: SalaryAccountMap,
  input: BuildSalaryInput,
): PostingCommand {
  const lines = sheet.lines;
  if (lines.length === 0) {
    throw new Error('buildSalaryCommand requires at least one salary sheet line');
  }

  const employerPfFor = employerPfLookup(input.employerPfByLine);

  // Group by (project, cost_centre — forced to Labour, purpose) so multi-project sheets stay tagged
  // per the worked group while the whole entry balances (design §4(b) / §10 multi-project split).
  const groups = new Map<string, DimGroup>();
  for (const line of lines) {
    const p = line.props;
    const costCentreId = accounts.labourCostCentreId; // cost line's cost centre is ALWAYS Labour (design §4(b))
    const key = `${p.projectId}::${costCentreId}::${p.purposeId}`;
    const employerPf = employerPfFor(line.id);
    const salaryPayable = p.grossAmount.minus(p.tds).minus(p.pf).minus(p.advanceRecovery);

    const existing = groups.get(key);
    if (existing) {
      existing.gross = existing.gross.plus(p.grossAmount);
      existing.employerPf = existing.employerPf.plus(employerPf);
      existing.tds = existing.tds.plus(p.tds);
      existing.employeePf = existing.employeePf.plus(p.pf);
      existing.advanceRecovery = existing.advanceRecovery.plus(p.advanceRecovery);
      existing.salaryPayable = existing.salaryPayable.plus(salaryPayable);
    } else {
      groups.set(key, {
        projectId: p.projectId,
        costCentreId,
        purposeId: p.purposeId,
        gross: p.grossAmount,
        employerPf,
        tds: p.tds,
        employeePf: p.pf,
        advanceRecovery: p.advanceRecovery,
        salaryPayable,
      });
    }
  }

  const postingLines: PostingLine[] = [];
  for (const g of groups.values()) {
    const dims = { projectId: g.projectId, costCentreId: g.costCentreId, purposeId: g.purposeId };
    const pfPayable = g.employerPf.plus(g.employeePf);

    // Dr Gross Salary & Wages
    postingLines.push({
      accountId: accounts.grossSalary,
      ...dims,
      debit: g.gross,
      credit: Money.zero(),
      accountType: 'EXPENSE',
      isControlAccount: false,
    });
    // Dr Employer PF Contribution (only when non-zero — avoids a spurious zero line)
    if (!g.employerPf.isZero()) {
      postingLines.push({
        accountId: accounts.employerPfContribution,
        ...dims,
        debit: g.employerPf,
        credit: Money.zero(),
        accountType: 'EXPENSE',
        isControlAccount: false,
      });
    }
    // Cr Salary Payable (net residual)
    postingLines.push({
      accountId: accounts.salaryPayable,
      ...dims,
      debit: Money.zero(),
      credit: g.salaryPayable,
      accountType: 'LIABILITY',
      isControlAccount: false,
    });
    // Cr TDS Payable
    if (!g.tds.isZero()) {
      postingLines.push({
        accountId: accounts.tdsPayable,
        ...dims,
        debit: Money.zero(),
        credit: g.tds,
        accountType: 'LIABILITY',
        isControlAccount: false,
      });
    }
    // Cr PF Payable (employer + employee)
    if (!pfPayable.isZero()) {
      postingLines.push({
        accountId: accounts.pfPayable,
        ...dims,
        debit: Money.zero(),
        credit: pfPayable,
        accountType: 'LIABILITY',
        isControlAccount: false,
      });
    }
    // Cr Staff Advance Recovery (asset ↓)
    if (!g.advanceRecovery.isZero()) {
      postingLines.push({
        accountId: accounts.staffAdvanceRecovery,
        ...dims,
        debit: Money.zero(),
        credit: g.advanceRecovery,
        accountType: 'ASSET',
        isControlAccount: false,
      });
    }
  }

  return {
    companyId: input.companyId,
    financialYearId: input.financialYearId,
    voucherType: 'SALARY',
    voucherDate: input.voucherDate,
    sourceType: SALARY_SOURCE_TYPE,
    sourceId: input.sourceId,
    postedBy: input.postedBy,
    narration: input.narration ?? undefined,
    lines: postingLines,
  };
}

function employerPfLookup(
  src: Map<string, Money> | Record<string, Money> | undefined,
): (lineId: string) => Money {
  if (!src) return () => Money.zero();
  if (src instanceof Map) return (lineId: string) => src.get(lineId) ?? Money.zero();
  return (lineId: string) => src[lineId] ?? Money.zero();
}

/** Convenience: build a line-keyed employer-PF map when every line shares one employer-PF rate off gross. */
export function employerPfFlatRate(lines: readonly SalarySheetLine[], rate: Money): Map<string, Money> {
  const map = new Map<string, Money>();
  for (const line of lines) {
    map.set(line.id, line.props.grossAmount.times(rate.amount).round());
  }
  return map;
}
