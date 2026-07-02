/**
 * JsonExporter (RPT · FR-RPT-005/-029) — INFRASTRUCTURE `FileExporter` for `format=json`. JSON IS the
 * format-neutral row model: this exporter returns the `ReportResult` unchanged (the platform
 * ResponseEnvelopeInterceptor then wraps it in the central `{ data, meta }` envelope). The Excel/PDF
 * adapters (RPT #30) render the SAME `ReportResult` to a binary download, so a report's numbers are
 * identical across all three formats — there is no per-format recomputation.
 */
import { Injectable } from '@nestjs/common';
import { ReportFormat } from '../../domain/report-descriptor';
import { ReportResult } from '../../domain/report-result.model';
import { FileExporter } from '../../domain/ports/file-exporter.port';

@Injectable()
export class JsonExporter implements FileExporter {
  readonly format: ReportFormat = 'json';

  render<Row>(result: ReportResult<Row>): ReportResult<Row> {
    return result;
  }
}
