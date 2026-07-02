/**
 * Format-neutrality (RPT · FR-RPT-029). One format-neutral `ReportResult` → identical numbers in JSON and
 * Excel. The JSON exporter returns the rows verbatim; the Excel exporter's parsed money cells equal those
 * same JSON strings, proving there is no per-format recomputation (AC2).
 */
import * as ExcelJS from 'exceljs';
import { JsonExporter } from '../../../../src/reports/infrastructure/exporters/json.exporter';
import { ExcelExporter } from '../../../../src/reports/infrastructure/exporters/excel.exporter';
import { BinaryDownload } from '../../../../src/reports/domain/ports/file-exporter.port';
import { ReportResult, ProjectPnlRow } from '../../../../src/reports/domain/report-result.model';

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const result: ReportResult<ProjectPnlRow> = {
  reportName: 'profit-and-loss',
  parameters: { financialYearId: 'fy1', dateTo: '2026-06-30' },
  rows: [
    { projectId: 'p1', costCentreId: null, revenue: '4000.0000', cost: '3200.0000', profit: '800.0000' },
    { projectId: 'p2', costCentreId: null, revenue: '1000.0000', cost: '0.0000', profit: '1000.0000' },
  ],
  totals: { revenue: '5000.0000', cost: '3200.0000', profit: '1800.0000' },
  generatedAt: '2026-07-02T00:00:00.000Z',
};

describe('format neutrality — same ReportResult → same numbers (FR-RPT-029)', () => {
  it('JSON returns the rows verbatim; Excel cells carry the identical money strings', async () => {
    const json = new JsonExporter().render(result);
    // JSON is the source of truth
    expect(json.rows).toEqual(result.rows);
    expect(json.totals).toEqual(result.totals);

    const dl = new ExcelExporter().render(result) as BinaryDownload;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await collect(dl.stream)) as unknown as ArrayBuffer);
    const flat: string[] = [];
    wb.worksheets[0].eachRow((row) => {
      row.eachCell({ includeEmpty: true }, (cell) => flat.push(cell.value == null ? '' : String(cell.value)));
    });

    for (const row of result.rows) {
      expect(flat).toContain(row.revenue);
      expect(flat).toContain(row.cost);
      expect(flat).toContain(row.profit);
    }
    for (const value of Object.values(result.totals!)) {
      expect(flat).toContain(value);
    }
  });
});
