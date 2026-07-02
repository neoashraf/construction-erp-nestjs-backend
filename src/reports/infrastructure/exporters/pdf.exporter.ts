/**
 * PdfExporter (RPT · FR-RPT-029/-030/-031) — INFRASTRUCTURE `FileExporter` for `format=pdf`. Renders the
 * SAME format-neutral `ReportResult` as the JSON/Excel exporters, so the numbers are identical across
 * formats (FR-RPT-029). Uses pdfkit, which is itself a readable stream (rows written incrementally, then
 * `doc.end()` finalises — NFR-011). Wide registers (many columns) render in LANDSCAPE and paginate across
 * pages with the header re-drawn on each (AC7); the numbers are unchanged from JSON/Excel. Money renders
 * as `৳ Decimal(18,4)` (full precision via decimal.js), dates `DD/MM/YYYY`, Bangla passes through
 * untruncated. Statutory reports (trial balance) carry the company BIN/TIN block (FR-RPT-030).
 */
import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { ReportFormat } from '../../domain/report-descriptor';
import { ReportResult } from '../../domain/report-result.model';
import {
  BinaryDownload,
  ExportContext,
  FileExporter,
} from '../../domain/ports/file-exporter.port';
import { findReport } from '../../domain/report-catalog';
import {
  binTinBlock,
  deriveColumns,
  exportFilename,
  formatDateDDMMYYYY,
  humanizeKey,
  isDateKey,
  isMoneyKey,
  taka,
} from './bd-format';

const PDF_CONTENT_TYPE = 'application/pdf';
/** More than this many columns → the register is "wide" and renders in landscape (AC7). */
const WIDE_COLUMN_THRESHOLD = 6;
/** Reports that must carry the company BIN/TIN in an NBR-acceptable layout (FR-RPT-030). */
const STATUTORY_REPORTS = new Set<string>(['trial-balance']);

const MARGIN = 36;
const ROW_HEIGHT = 16;
const FONT_SIZE = 8;

@Injectable()
export class PdfExporter implements FileExporter {
  readonly format: ReportFormat = 'pdf';

  render<Row>(result: ReportResult<Row>, ctx?: ExportContext): BinaryDownload {
    const columns = deriveColumns(result.rows);
    const landscape = columns.length > WIDE_COLUMN_THRESHOLD;

    const doc = new PDFDocument({
      size: 'A4',
      layout: landscape ? 'landscape' : 'portrait',
      margin: MARGIN,
      bufferPages: true,
    });

    this.draw(doc, result, ctx, columns);
    doc.end(); // finalise; the stream flushes and ends

    return {
      stream: doc,
      contentType: PDF_CONTENT_TYPE,
      filename: exportFilename(result.reportName, result.parameters, 'pdf'),
    };
  }

  private draw<Row>(
    doc: PDFKit.PDFDocument,
    result: ReportResult<Row>,
    ctx: ExportContext | undefined,
    columns: string[],
  ): void {
    const title = findReport(result.reportName)?.title ?? result.reportName;
    doc.fontSize(14).text(title);

    if (STATUTORY_REPORTS.has(result.reportName) && ctx?.company) {
      doc.moveDown(0.3).fontSize(9);
      for (const line of binTinBlock(ctx.company)) doc.text(line);
    }

    doc.moveDown(0.3).fontSize(9);
    doc.text(`Generated: ${formatDateDDMMYYYY(result.generatedAt)}`);
    doc.text(`Scope: ${this.scopeLabel(result.parameters)}`);
    doc.moveDown(0.5);

    if (columns.length === 0) {
      doc.fontSize(11).text('No data');
    } else {
      this.drawTable(doc, columns, result.rows);
    }

    if (result.totals) {
      doc.moveDown(0.5).fontSize(9);
      for (const [key, value] of Object.entries(result.totals)) {
        doc.text(`TOTAL ${key.toUpperCase()}: ${taka(value)}`);
      }
    }
  }

  private drawTable<Row>(doc: PDFKit.PDFDocument, columns: string[], rows: Row[]): void {
    const usableWidth = doc.page.width - MARGIN * 2;
    const colWidth = usableWidth / columns.length;
    const bottom = doc.page.height - MARGIN;

    const drawHeader = (): void => {
      doc.fontSize(FONT_SIZE).font('Helvetica-Bold');
      const y = doc.y;
      columns.forEach((key, i) => {
        doc.text(humanizeKey(key), MARGIN + i * colWidth, y, {
          width: colWidth,
          ellipsis: false,
        });
      });
      doc.font('Helvetica');
      doc.y = y + ROW_HEIGHT;
    };

    drawHeader();

    for (const row of rows) {
      if (doc.y + ROW_HEIGHT > bottom) {
        doc.addPage(); // paginate wide/long registers (AC7)
        drawHeader();
      }
      const y = doc.y;
      columns.forEach((key, i) => {
        doc.text(this.cell(row, key), MARGIN + i * colWidth, y, {
          width: colWidth,
          ellipsis: false, // never truncate (Bangla-safe)
        });
      });
      doc.y = y + ROW_HEIGHT;
    }
  }

  /** A single cell string. Money → `৳ Decimal(18,4)` (value equals JSON); dates → `DD/MM/YYYY`; else raw. */
  private cell<Row>(row: Row, key: string): string {
    const value = (row as Record<string, unknown>)[key];
    if (value === null || value === undefined) return '';
    if (isMoneyKey(key)) return taka(String(value));
    if (isDateKey(key)) return formatDateDDMMYYYY(String(value));
    return String(value);
  }

  private scopeLabel(params: Record<string, unknown>): string {
    return typeof params.projectId === 'string' && params.projectId
      ? `Project ${params.projectId}`
      : 'Consolidated';
  }
}
