/**
 * ExcelExporter (RPT · FR-RPT-029/-030/-031). Parses the generated .xlsx buffer back with ExcelJS and
 * asserts the cell values equal the ReportResult rows/totals (numbers identical across formats — AC2),
 * that money keeps its exact Decimal(18,4) string (AC10), that Bangla is un-truncated (FR-RPT-030), that
 * a statutory report carries the BIN/TIN block (AC5), and that an empty report still yields a well-formed
 * workbook (AC8).
 */
import * as ExcelJS from 'exceljs';
import { ExcelExporter } from '../../../../src/reports/infrastructure/exporters/excel.exporter';
import { BinaryDownload } from '../../../../src/reports/domain/ports/file-exporter.port';
import { ReportResult, TrialBalanceRow } from '../../../../src/reports/domain/report-result.model';

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function parse(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb.worksheets[0];
}

/** All cell text of the sheet, one array per row (1-based rows flattened to strings). */
function textRows(ws: ExcelJS.Worksheet): string[][] {
  const out: string[][] = [];
  ws.eachRow((row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => cells.push(cell.value == null ? '' : String(cell.value)));
    out.push(cells);
  });
  return out;
}

const trialBalance: ReportResult<TrialBalanceRow> = {
  reportName: 'trial-balance',
  parameters: { financialYearId: 'fy1', projectId: null, dateTo: '2026-06-30' },
  rows: [
    {
      accountId: 'cash', projectId: null, costCentreId: null, purposeId: null, godownId: null,
      partyId: null, debit: '10000.0000', credit: '0.0000', net: '10000.0000',
    },
    {
      accountId: 'revenue', projectId: 'জাকির', costCentreId: null, purposeId: null, godownId: null,
      partyId: null, debit: '0.0000', credit: '10000.0000', net: '-10000.0000',
    },
  ],
  totals: { debit: '10000.0000', credit: '10000.0000' },
  generatedAt: '2026-07-02T00:00:00.000Z',
};

describe('ExcelExporter', () => {
  const exporter = new ExcelExporter();

  it('declares format excel and a .xlsx download with the correct content type + filename', async () => {
    expect(exporter.format).toBe('excel');
    const dl = exporter.render(trialBalance) as BinaryDownload;
    expect(dl.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(dl.filename).toBe('trial-balance-consolidated-30-06-2026.xlsx');
    await collect(dl.stream); // drain
  });

  it('parsed cell values equal the ReportResult rows and totals (numbers identical — AC2/AC10)', async () => {
    const dl = exporter.render(trialBalance) as BinaryDownload;
    const ws = await parse(await collect(dl.stream));
    const rows = textRows(ws);

    // money cells carry the exact Decimal(18,4) string
    const flat = rows.flat();
    expect(flat).toContain('10000.0000');
    expect(flat).toContain('-10000.0000');

    // header row for the data table
    const headerRow = rows.find((r) => r.includes('Account Id') && r.includes('Debit') && r.includes('Credit'));
    expect(headerRow).toBeDefined();
    const debitCol = headerRow!.indexOf('Debit');
    const creditCol = headerRow!.indexOf('Credit');

    // data rows equal the source rows exactly
    const cashRow = rows.find((r) => r.includes('cash'));
    expect(cashRow![debitCol]).toBe('10000.0000');
    expect(cashRow![creditCol]).toBe('0.0000');

    // totals rows
    expect(rows).toContainEqual(expect.arrayContaining(['TOTAL DEBIT', '10000.0000']));
    expect(rows).toContainEqual(expect.arrayContaining(['TOTAL CREDIT', '10000.0000']));
  });

  it('Bangla text is written un-truncated (FR-RPT-030)', async () => {
    const dl = exporter.render(trialBalance) as BinaryDownload;
    const ws = await parse(await collect(dl.stream));
    expect(textRows(ws).flat()).toContain('জাকির');
  });

  it('statutory report carries the company BIN/TIN block (AC5)', async () => {
    const dl = exporter.render(trialBalance, {
      company: { name: 'ZE', legalName: 'Zakir Enterprise Ltd', bin: '1234567890123', tin: '123456789012' },
    }) as BinaryDownload;
    const ws = await parse(await collect(dl.stream));
    const flat = textRows(ws).flat();
    expect(flat).toContain('BIN: 1234567890123    TIN: 123456789012');
  });

  it('empty report → a well-formed workbook, not an error (AC8)', async () => {
    const empty: ReportResult<TrialBalanceRow> = {
      reportName: 'trial-balance',
      parameters: { financialYearId: 'fy1' },
      rows: [],
      totals: { debit: '0.0000', credit: '0.0000' },
      generatedAt: '2026-07-02T00:00:00.000Z',
    };
    const dl = exporter.render(empty) as BinaryDownload;
    const ws = await parse(await collect(dl.stream));
    const flat = textRows(ws).flat();
    expect(flat).toContain('No data');
    expect(flat).toContain('0.0000');
  });
});
