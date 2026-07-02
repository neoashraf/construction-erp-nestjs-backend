/**
 * JsonExporter (RPT · FR-RPT-029). JSON is the format-neutral row model: the exporter returns the
 * ReportResult (its rows/totals) unchanged, so the numbers rendered are exactly the query's numbers.
 */
import { JsonExporter } from '../../../src/reports/infrastructure/exporters/json.exporter';
import { ReportResult, TrialBalanceRow } from '../../../src/reports/domain/report-result.model';

describe('JsonExporter', () => {
  const exporter = new JsonExporter();

  it('declares format json', () => {
    expect(exporter.format).toBe('json');
  });

  it('returns the format-neutral row model unchanged', () => {
    const result: ReportResult<TrialBalanceRow> = {
      reportName: 'trial-balance',
      parameters: { financialYearId: 'fy1' },
      rows: [
        { accountId: 'a1', projectId: null, costCentreId: null, purposeId: null, godownId: null, partyId: null,
          debit: '100.0000', credit: '0.0000', net: '100.0000' },
      ],
      totals: { debit: '100.0000', credit: '100.0000' },
      generatedAt: '2026-07-02T00:00:00.000Z',
    };
    const out = exporter.render(result);
    expect(out).toBe(result);
    expect(out.rows).toEqual(result.rows);
    expect(out.totals).toEqual({ debit: '100.0000', credit: '100.0000' });
  });
});
