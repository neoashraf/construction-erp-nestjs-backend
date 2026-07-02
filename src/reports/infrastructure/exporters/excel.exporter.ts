/**
 * ExcelExporter (RPT · FR-RPT-029/-030/-031) — INFRASTRUCTURE `FileExporter` for `format=excel`. Renders
 * the SAME format-neutral `ReportResult` the JSON exporter returns, so the numbers are identical across
 * formats (FR-RPT-029). Uses the ExcelJS STREAMING workbook writer (`ExcelJS.stream.xlsx.WorkbookWriter`)
 * so rows flush incrementally and a year's ledger export does not exhaust memory (NFR-011). Money cells
 * carry the exact `Decimal(18,4)` decimal string (never a JS float — full precision, byte-identical to the
 * JSON value); dates render `DD/MM/YYYY`; Bangla text is written UTF-8, never truncated. Statutory reports
 * (trial balance) get the company BIN/TIN header block for NBR-acceptable output (FR-RPT-030).
 */
import { Injectable } from '@nestjs/common';
import { PassThrough } from 'stream';
import * as ExcelJS from 'exceljs';
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
} from './bd-format';

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Reports that must carry the company BIN/TIN in an NBR-acceptable layout (FR-RPT-030). */
const STATUTORY_REPORTS = new Set<string>(['trial-balance']);

@Injectable()
export class ExcelExporter implements FileExporter {
  readonly format: ReportFormat = 'excel';

  render<Row>(result: ReportResult<Row>, ctx?: ExportContext): BinaryDownload {
    const stream = new PassThrough();
    // Fire the streaming write; on any failure destroy the stream so the pipe surfaces the error.
    void this.write(result, ctx, stream).catch((err: unknown) =>
      stream.destroy(err instanceof Error ? err : new Error(String(err))),
    );
    return {
      stream,
      contentType: XLSX_CONTENT_TYPE,
      filename: exportFilename(result.reportName, result.parameters, 'xlsx'),
    };
  }

  private async write<Row>(
    result: ReportResult<Row>,
    ctx: ExportContext | undefined,
    stream: PassThrough,
  ): Promise<void> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
    const sheet = workbook.addWorksheet('Report');

    const title = findReport(result.reportName)?.title ?? result.reportName;
    sheet.addRow([title]).commit();

    // Statutory BIN/TIN block (NBR-acceptable) — trial balance etc.
    if (STATUTORY_REPORTS.has(result.reportName) && ctx?.company) {
      for (const line of binTinBlock(ctx.company)) sheet.addRow([line]).commit();
    }

    sheet.addRow([`Generated: ${formatDateDDMMYYYY(result.generatedAt)}`]).commit();
    sheet.addRow([`Scope: ${this.scopeLabel(result.parameters)}`]).commit();
    sheet.addRow([]).commit(); // spacer

    const columns = deriveColumns(result.rows);
    if (columns.length > 0) {
      sheet.addRow(columns.map(humanizeKey)).commit();
      for (const row of result.rows) {
        sheet.addRow(columns.map((key) => this.cell(row, key))).commit();
      }
    } else {
      sheet.addRow(['No data']).commit();
    }

    // Reconciling totals (TB {debit,credit}; P&L {revenue,cost,profit}; …) — one labelled row per total.
    if (result.totals) {
      sheet.addRow([]).commit();
      for (const [key, value] of Object.entries(result.totals)) {
        sheet.addRow([`TOTAL ${key.toUpperCase()}`, value]).commit();
      }
    }

    await sheet.commit();
    await workbook.commit();
  }

  /**
   * A single cell value. Money keeps its exact `Decimal(18,4)` string (full precision, equal to the JSON
   * value — AC2/AC10); dates render `DD/MM/YYYY`; everything else (ids, Bangla names) passes through
   * untruncated.
   */
  private cell<Row>(row: Row, key: string): string | number | boolean {
    const value = (row as Record<string, unknown>)[key];
    if (value === null || value === undefined) return '';
    if (isMoneyKey(key)) return String(value);
    if (isDateKey(key)) return formatDateDDMMYYYY(String(value));
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    return String(value);
  }

  private scopeLabel(params: Record<string, unknown>): string {
    return typeof params.projectId === 'string' && params.projectId
      ? `Project ${params.projectId}`
      : 'Consolidated';
  }
}
