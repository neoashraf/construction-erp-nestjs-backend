/**
 * PdfExporter (RPT · FR-RPT-029/-030/-031). A PDF is opaque to cell-parsing, so we assert it is a valid,
 * non-empty PDF document (starts with `%PDF`) for a populated report, a wide register, and an EMPTY report
 * (AC8), and that the download advertises the correct content type + filename (AC3). Numbers are proven
 * identical to JSON/Excel by the shared render path + the format-neutrality spec.
 */
import { PdfExporter } from '../../../../src/reports/infrastructure/exporters/pdf.exporter';
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

const isPdf = (buf: Buffer): boolean => buf.length > 0 && buf.subarray(0, 4).toString('ascii') === '%PDF';

const wideRow = (id: string, debit: string, credit: string): TrialBalanceRow => ({
  accountId: id, projectId: null, costCentreId: null, purposeId: null, godownId: null,
  partyId: null, debit, credit, net: debit,
});

const trialBalance: ReportResult<TrialBalanceRow> = {
  reportName: 'trial-balance',
  parameters: { financialYearId: 'fy1', dateTo: '2026-06-30' },
  rows: [wideRow('cash', '10000.0000', '0.0000'), wideRow('revenue', '0.0000', '10000.0000')],
  totals: { debit: '10000.0000', credit: '10000.0000' },
  generatedAt: '2026-07-02T00:00:00.000Z',
};

describe('PdfExporter', () => {
  const exporter = new PdfExporter();

  it('declares format pdf and an application/pdf download with the right filename', async () => {
    expect(exporter.format).toBe('pdf');
    const dl = exporter.render(trialBalance) as BinaryDownload;
    expect(dl.contentType).toBe('application/pdf');
    expect(dl.filename).toBe('trial-balance-consolidated-30-06-2026.pdf');
    await collect(dl.stream);
  });

  it('produces a valid, non-empty PDF for a populated report', async () => {
    const dl = exporter.render(trialBalance) as BinaryDownload;
    const buf = await collect(dl.stream);
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
  });

  it('produces a valid PDF for a wide register (landscape + pagination path, AC7)', async () => {
    // 9 columns → wide → landscape; many rows → exercises pagination
    const rows = Array.from({ length: 200 }, (_, i) => wideRow(`acc-${i}`, `${i}.0000`, '0.0000'));
    const dl = exporter.render({ ...trialBalance, rows }) as BinaryDownload;
    const buf = await collect(dl.stream);
    expect(isPdf(buf)).toBe(true);
  });

  it('empty report → a valid PDF, not an error (AC8)', async () => {
    const empty: ReportResult<TrialBalanceRow> = {
      reportName: 'trial-balance',
      parameters: { financialYearId: 'fy1' },
      rows: [],
      totals: { debit: '0.0000', credit: '0.0000' },
      generatedAt: '2026-07-02T00:00:00.000Z',
    };
    const dl = exporter.render(empty) as BinaryDownload;
    const buf = await collect(dl.stream);
    expect(isPdf(buf)).toBe(true);
  });

  it('carries the BIN/TIN block without failing for a statutory report (AC5)', async () => {
    const dl = exporter.render(trialBalance, {
      company: { name: 'ZE', bin: '1234567890123', tin: '123456789012' },
    }) as BinaryDownload;
    const buf = await collect(dl.stream);
    expect(isPdf(buf)).toBe(true);
  });
});
