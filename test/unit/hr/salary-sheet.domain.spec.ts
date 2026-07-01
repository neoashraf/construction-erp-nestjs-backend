/**
 * SalarySheet aggregate domain unit tests (no DB, no Nest). Covers generate() building a DRAFT, per-line
 * editComponents/applyBulk recomputing totals (FR-HR-014), the DRAFT-only guard on edits/post
 * (SalaryNotDraftError), markPosted's DRAFT->POSTED transition recording salary_entry_id, and totals()'s
 * Σgross/Σdeductions/Σnet rollup. Cites FR-HR-013/-014/-015.
 */
import { Money } from '../../../src/common/money';
import { SalaryNotDraftError } from '../../../src/modules/hr/domain/errors';
import { SalarySheet, SalarySheetLine } from '../../../src/modules/hr/domain/salary-sheet';

function line(id: string, gross: string, employeeId = `emp-${id}`): SalarySheetLine {
  return SalarySheetLine.create(id, {
    employeeId,
    projectId: 'P-01',
    costCentreId: 'cc-labour',
    purposeId: 'pur-1',
    paidDays: '30',
    gross: Money.of(gross),
  });
}

function draftSheet(lines: SalarySheetLine[]): SalarySheet {
  return SalarySheet.generate(
    'sheet-1',
    'co1',
    { financialYearId: 'fy1', periodLabel: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30' },
    lines,
  );
}

describe('SalarySheet.generate', () => {
  it('builds a DRAFT sheet with the supplied lines', () => {
    const sheet = draftSheet([line('l1', '50000'), line('l2', '60000')]);
    expect(sheet.props.status).toBe('DRAFT');
    expect(sheet.props.salaryEntryId).toBeNull();
    expect(sheet.lines).toHaveLength(2);
  });

  it('rejects periodEnd before periodStart', () => {
    expect(() =>
      SalarySheet.generate(
        'sheet-bad',
        'co1',
        { financialYearId: 'fy1', periodLabel: '2026-06', periodStart: '2026-06-30', periodEnd: '2026-06-01' },
        [],
      ),
    ).toThrow();
  });
});

describe('SalarySheet.totals', () => {
  it('sums gross/deductions/net across all lines', () => {
    const l1 = SalarySheetLine.create('l1', {
      employeeId: 'e1',
      projectId: 'P-01',
      costCentreId: 'cc-labour',
      purposeId: 'pur-1',
      paidDays: '30',
      gross: Money.of('50000'),
      components: { tds: '5000', pf: '2000' },
    });
    const l2 = SalarySheetLine.create('l2', {
      employeeId: 'e2',
      projectId: 'P-01',
      costCentreId: 'cc-labour',
      purposeId: 'pur-1',
      paidDays: '30',
      gross: Money.of('30000'),
      components: { allowances: '1000', advanceRecovery: '3000' },
    });
    const sheet = draftSheet([l1, l2]);
    const totals = sheet.totals();
    expect(totals.gross.toFixed()).toBe('80000.0000');
    expect(totals.deductions.toFixed()).toBe('10000.0000'); // 5000+2000 + 3000
    // net: (50000-5000-2000) + (30000+1000-3000) = 43000 + 28000 = 71000
    expect(totals.net.toFixed()).toBe('71000.0000');
  });
});

describe('SalarySheet.editLine — DRAFT only (FR-HR-014)', () => {
  it('recomputes the line and its net from a component patch', () => {
    const l1 = line('l1', '50000');
    const sheet = draftSheet([l1]);
    const edited = sheet.editLine('l1', { tds: '4000', pf: '1000' });
    expect(edited.props.tds.toFixed()).toBe('4000.0000');
    expect(edited.props.pf.toFixed()).toBe('1000.0000');
    expect(edited.props.netAmount.toFixed()).toBe('45000.0000');
  });

  it('throws when the line id does not exist on the sheet', () => {
    const sheet = draftSheet([line('l1', '50000')]);
    expect(() => sheet.editLine('missing', { tds: '100' })).toThrow();
  });

  it('rejects editLine once the sheet is POSTED', () => {
    const sheet = draftSheet([line('l1', '50000')]);
    sheet.markPosted('entry-1', 'u1', new Date('2026-06-30T10:00:00Z'));
    expect(() => sheet.editLine('l1', { tds: '100' })).toThrow(SalaryNotDraftError);
  });
});

describe('SalarySheet.applyBulkComponents — DRAFT only (FR-HR-014)', () => {
  it('applies a flat allowance across ALL lines when employeeIds is omitted', () => {
    const l1 = line('l1', '50000', 'emp-1');
    const l2 = line('l2', '30000', 'emp-2');
    const sheet = draftSheet([l1, l2]);
    sheet.applyBulkComponents({ allowances: '1000' });
    expect(sheet.lines[0].props.allowances.toFixed()).toBe('1000.0000');
    expect(sheet.lines[1].props.allowances.toFixed()).toBe('1000.0000');
  });

  it('applies a TDS rate off gross', () => {
    const l1 = line('l1', '50000', 'emp-1');
    const sheet = draftSheet([l1]);
    sheet.applyBulkComponents({ tdsRate: '0.1' }); // 10% of 50,000 = 5,000
    expect(sheet.lines[0].props.tds.toFixed()).toBe('5000.0000');
  });

  it('scopes the bulk rule to the given employeeIds only', () => {
    const l1 = line('l1', '50000', 'emp-1');
    const l2 = line('l2', '30000', 'emp-2');
    const sheet = draftSheet([l1, l2]);
    sheet.applyBulkComponents({ allowances: '2000', employeeIds: ['emp-1'] });
    expect(sheet.lines[0].props.allowances.toFixed()).toBe('2000.0000');
    expect(sheet.lines[1].props.allowances.toFixed()).toBe('0.0000');
  });

  it('rejects bulk-apply once the sheet is POSTED', () => {
    const sheet = draftSheet([line('l1', '50000')]);
    sheet.markPosted('entry-1', 'u1', new Date('2026-06-30T10:00:00Z'));
    expect(() => sheet.applyBulkComponents({ allowances: '100' })).toThrow(SalaryNotDraftError);
  });
});

describe('SalarySheet.assertPostable / markPosted', () => {
  it('markPosted transitions DRAFT -> POSTED and records salary_entry_id', () => {
    const sheet = draftSheet([line('l1', '50000')]);
    sheet.assertPostable(); // does not throw
    sheet.markPosted('entry-1', 'u1', new Date('2026-06-30T10:00:00Z'));
    expect(sheet.props.status).toBe('POSTED');
    expect(sheet.props.salaryEntryId).toBe('entry-1');
    expect(sheet.props.postedBy).toBe('u1');
  });

  it('markPosted again throws SalaryNotDraftError (post() is DRAFT-only)', () => {
    const sheet = draftSheet([line('l1', '50000')]);
    sheet.markPosted('entry-1', 'u1', new Date('2026-06-30T10:00:00Z'));
    expect(() => sheet.markPosted('entry-2', 'u1', new Date())).toThrow(SalaryNotDraftError);
    expect(() => sheet.assertPostable()).toThrow(SalaryNotDraftError);
  });

  it('the stored status is NEVER a literal REVERSED value — only DRAFT|POSTED are ever set', () => {
    const sheet = draftSheet([line('l1', '50000')]);
    sheet.markPosted('entry-1', 'u1', new Date());
    expect(['DRAFT', 'POSTED']).toContain(sheet.props.status);
  });
});
