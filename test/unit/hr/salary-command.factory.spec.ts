/**
 * HR salary-command.factory unit tests (no DB, no Nest). 100% coverage target (brief DoD). Proves the
 * design §4(b) worked template exactly: gross 500,000 + employerPF 25,000 / salary payable 405,000 +
 * TDS 40,000 + PF payable 50,000 + advance 30,000 -> Σdebit = Σcredit = 525,000.0000 (exact Decimal); every
 * line tagged project + cost_centre(Labour) + purpose; NO godown; NO party (aggregate liability, Phase 1);
 * the employer-PF Dr-and-Cr arithmetic (line 2 debit + folded into the PF-payable credit). Cites FR-HR-015.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../src/common/money';
import { SalarySheet, SalarySheetLine } from '../../../src/modules/hr/domain/salary-sheet';
import { buildSalaryCommand, SalaryAccountMap } from '../../../src/modules/hr/domain/salary-command.factory';

const ACCOUNTS: SalaryAccountMap = {
  grossSalary: 'acc-gross',
  employerPfContribution: 'acc-employer-pf',
  salaryPayable: 'acc-salary-payable',
  tdsPayable: 'acc-tds-payable',
  pfPayable: 'acc-pf-payable',
  staffAdvanceRecovery: 'acc-advance',
  labourCostCentreId: 'cc-labour',
};

function sum(lines: { debit: Money; credit: Money }[]): { dr: Decimal; cr: Decimal } {
  return lines.reduce(
    (s, l) => ({ dr: s.dr.plus(l.debit.amount), cr: s.cr.plus(l.credit.amount) }),
    { dr: new Decimal(0), cr: new Decimal(0) },
  );
}

/** Build a one-line DRAFT sheet whose SalarySheetLine already carries the §4(b) worked figures. */
function workedSheet(): SalarySheet {
  // gross 500,000; tds 40,000; employee pf 25,000; advance 30,000 -> line net computed by applyComponents.
  const line = SalarySheetLine.create('line-1', {
    employeeId: 'emp-1',
    projectId: 'P-01',
    costCentreId: 'cc-ignored-by-factory', // the factory forces cost_centre to accounts.labourCostCentreId
    purposeId: 'PUR-Payroll-2026-06',
    paidDays: '30',
    gross: Money.of('500000'),
    components: { tds: '40000', pf: '25000', advanceRecovery: '30000' },
  });
  return SalarySheet.generate(
    'sheet-1',
    'co1',
    { financialYearId: 'fy1', periodLabel: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30' },
    [line],
  );
}

describe('buildSalaryCommand — design §4(b) worked template', () => {
  it('balances at exactly 525,000.0000 as exact Decimal (employer PF 25,000 supplied)', () => {
    const sheet = workedSheet();
    const employerPfByLine = new Map([[sheet.lines[0].id, Money.of('25000')]]);
    const cmd = buildSalaryCommand(sheet, ACCOUNTS, {
      companyId: 'co1',
      financialYearId: 'fy1',
      voucherDate: '2026-06-30',
      sourceId: sheet.id,
      postedBy: 'u1',
      employerPfByLine,
    });
    const { dr, cr } = sum(cmd.lines);
    expect(dr.toFixed(4)).toBe('525000.0000');
    expect(cr.toFixed(4)).toBe('525000.0000');
    expect(dr.equals(cr)).toBe(true);
    expect(cmd.voucherType).toBe('SALARY');
  });

  it('salary payable = 405,000 and PF payable = 50,000 (employer 25,000 + employee 25,000)', () => {
    const sheet = workedSheet();
    const employerPfByLine = new Map([[sheet.lines[0].id, Money.of('25000')]]);
    const cmd = buildSalaryCommand(sheet, ACCOUNTS, {
      companyId: 'co1',
      financialYearId: 'fy1',
      voucherDate: '2026-06-30',
      sourceId: sheet.id,
      postedBy: 'u1',
      employerPfByLine,
    });
    const salaryPayableLine = cmd.lines.find((l) => l.accountId === 'acc-salary-payable')!;
    const pfPayableLine = cmd.lines.find((l) => l.accountId === 'acc-pf-payable')!;
    const tdsPayableLine = cmd.lines.find((l) => l.accountId === 'acc-tds-payable')!;
    const advanceLine = cmd.lines.find((l) => l.accountId === 'acc-advance')!;
    const grossLine = cmd.lines.find((l) => l.accountId === 'acc-gross')!;
    const employerPfLine = cmd.lines.find((l) => l.accountId === 'acc-employer-pf')!;

    expect(grossLine.debit.toFixed()).toBe('500000.0000');
    expect(employerPfLine.debit.toFixed()).toBe('25000.0000');
    expect(salaryPayableLine.credit.toFixed()).toBe('405000.0000');
    expect(tdsPayableLine.credit.toFixed()).toBe('40000.0000');
    expect(pfPayableLine.credit.toFixed()).toBe('50000.0000');
    expect(advanceLine.credit.toFixed()).toBe('30000.0000');
  });

  it('every line carries project + cost_centre(Labour, forced) + purpose; no godown/party', () => {
    const sheet = workedSheet();
    const cmd = buildSalaryCommand(sheet, ACCOUNTS, {
      companyId: 'co1',
      financialYearId: 'fy1',
      voucherDate: '2026-06-30',
      sourceId: sheet.id,
      postedBy: 'u1',
    });
    for (const l of cmd.lines) {
      expect(l.projectId).toBe('P-01');
      expect(l.costCentreId).toBe('cc-labour'); // forced to the resolved Labour cost centre, not the line's own
      expect(l.purposeId).toBe('PUR-Payroll-2026-06');
      expect(l.godownId).toBeUndefined();
      expect(l.partyId).toBeUndefined();
    }
  });

  it('omitting employer PF (no map) still balances — 500,000 = 40,000+25,000(pf, employee-only)+30,000+405,000-... check exact', () => {
    const sheet = workedSheet();
    const cmd = buildSalaryCommand(sheet, ACCOUNTS, {
      companyId: 'co1',
      financialYearId: 'fy1',
      voucherDate: '2026-06-30',
      sourceId: sheet.id,
      postedBy: 'u1',
      // no employerPfByLine -> employer PF defaults to 0
    });
    const { dr, cr } = sum(cmd.lines);
    expect(dr.equals(cr)).toBe(true);
    expect(dr.toFixed(4)).toBe('500000.0000'); // just gross; pf payable becomes employee-only 25,000
    const pfPayableLine = cmd.lines.find((l) => l.accountId === 'acc-pf-payable')!;
    expect(pfPayableLine.credit.toFixed()).toBe('25000.0000');
    expect(cmd.lines.find((l) => l.accountId === 'acc-employer-pf')).toBeUndefined(); // zero line omitted
  });

  it('groups multiple employees sharing the same (project, purpose) into one aggregated Dr/Cr set', () => {
    const line1 = SalarySheetLine.create('line-1', {
      employeeId: 'emp-1',
      projectId: 'P-01',
      costCentreId: 'ignored',
      purposeId: 'PUR-2026-06',
      paidDays: '30',
      gross: Money.of('300000'),
      components: { tds: '20000', pf: '15000', advanceRecovery: '10000' },
    });
    const line2 = SalarySheetLine.create('line-2', {
      employeeId: 'emp-2',
      projectId: 'P-01',
      costCentreId: 'ignored',
      purposeId: 'PUR-2026-06',
      paidDays: '30',
      gross: Money.of('200000'),
      components: { tds: '20000', pf: '10000', advanceRecovery: '20000' },
    });
    const sheet = SalarySheet.generate(
      'sheet-2',
      'co1',
      { financialYearId: 'fy1', periodLabel: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30' },
      [line1, line2],
    );
    const cmd = buildSalaryCommand(sheet, ACCOUNTS, {
      companyId: 'co1',
      financialYearId: 'fy1',
      voucherDate: '2026-06-30',
      sourceId: sheet.id,
      postedBy: 'u1',
    });
    // one dims group -> at most one line per account role (gross/salaryPayable/tds/pf/advance; no employer PF)
    const grossLines = cmd.lines.filter((l) => l.accountId === 'acc-gross');
    expect(grossLines).toHaveLength(1);
    expect(grossLines[0].debit.toFixed()).toBe('500000.0000'); // 300,000 + 200,000
    const { dr, cr } = sum(cmd.lines);
    expect(dr.equals(cr)).toBe(true);
  });

  it('throws when the sheet has zero lines', () => {
    const empty = SalarySheet.generate(
      'sheet-empty',
      'co1',
      { financialYearId: 'fy1', periodLabel: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30' },
      [],
    );
    expect(() =>
      buildSalaryCommand(empty, ACCOUNTS, {
        companyId: 'co1',
        financialYearId: 'fy1',
        voucherDate: '2026-06-30',
        sourceId: empty.id,
        postedBy: 'u1',
      }),
    ).toThrow();
  });
});
