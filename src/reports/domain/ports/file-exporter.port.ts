/**
 * FileExporter (RPT · FR-RPT-029/-031) — PURE domain port. The single seam through which a report's
 * format-neutral `ReportResult` is materialised: JSON returns the plain body (the interceptor wraps it in
 * the central `{ data, meta }` envelope); Excel/PDF return a binary file download (the one deliberate
 * exception to the envelope — overview §6). This brief ships the JSON exporter only; the Excel/PDF
 * adapters land in RPT #30. Because all formats render the SAME model, a report's numbers are identical
 * across formats.
 */
import { ReportFormat } from '../report-descriptor';
import { ReportResult } from '../report-result.model';

export const FILE_EXPORTER = Symbol('FILE_EXPORTER');

export interface BinaryDownload {
  /** Streamed so a large export does not exhaust memory (NFR-011). */
  stream: NodeJS.ReadableStream;
  contentType: string;
  /** Content-Disposition: attachment; filename="<report>-<scope>-<DD-MM-YYYY>.<ext>". */
  filename: string;
}

export interface FileExporter {
  /** The format this exporter renders. */
  readonly format: ReportFormat;
  /** Render a format-neutral result: JSON → the plain body object; Excel/PDF → a binary download. */
  render<Row>(result: ReportResult<Row>): ReportResult<Row> | BinaryDownload;
}
