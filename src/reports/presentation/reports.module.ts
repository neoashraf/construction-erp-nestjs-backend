/**
 * ReportsModule (RPT) — composition root for the read-only reporting layer. Binds the domain read/export
 * ports to their adapters and wires the `/api/reports` controller. RPT owns NO entity, NO migration, and
 * NEVER calls `PostingService`: it depends only on the shared `DATA_SOURCE` (global) for the scoped ledger
 * SQL and on `AuthModule` for the JwtAuthGuard/RolesGuard behind `@Roles({ module:'RPT', action:'READ' })`.
 *
 * SEAM: `LEDGER_READ_PORT` → `LedgerReadAdapter` runs the SAME canonical aggregation LED's read service
 * uses (LED does not export its `LedgerQueryService` and this brief forbids modifying LED — so RPT runs
 * the identical scoped SQL over `journal_line`/`journal_entry`, never a second definition, FR-RPT-004).
 * `FILE_EXPORTER` is a MULTI provider — one `FileExporter` adapter per format (`JsonExporter` +, from RPT
 * #30, `ExcelExporter` / `PdfExporter`); the controller selects the adapter by the `format` parameter.
 * `CompanyQueryService` supplies the BIN/TIN header block for statutory exports (FR-RPT-030). Later RPT
 * briefs add the CC/SAL/INV/HR/REQ read ports for the project/inventory/HR reports.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../../core/auth/auth.module';
import { CompanyQueryService } from '../../modules/master-data/company/read/company.query-service';
import { ReportQueryService } from '../application/report-query.service';
import { ReportScopeService } from '../application/report-scope.service';
import { LEDGER_READ_PORT } from '../domain/ports/ledger.read.port';
import { FILE_EXPORTER } from '../domain/ports/file-exporter.port';
import { LedgerReadAdapter } from '../infrastructure/ledger.read.adapter';
import { JsonExporter } from '../infrastructure/exporters/json.exporter';
import { ExcelExporter } from '../infrastructure/exporters/excel.exporter';
import { PdfExporter } from '../infrastructure/exporters/pdf.exporter';
import { ReportsController } from './reports.controller';

@Module({
  imports: [AuthModule],
  controllers: [ReportsController],
  providers: [
    ReportQueryService,
    ReportScopeService,
    CompanyQueryService,
    JsonExporter,
    ExcelExporter,
    PdfExporter,
    { provide: LEDGER_READ_PORT, useClass: LedgerReadAdapter },
    // One FileExporter adapter per format, exposed as an array; the controller keys it by `format`
    // and selects the right adapter (FR-RPT-029). Adding CSV later is a fourth adapter here, no more.
    {
      provide: FILE_EXPORTER,
      useFactory: (json: JsonExporter, excel: ExcelExporter, pdf: PdfExporter) => [json, excel, pdf],
      inject: [JsonExporter, ExcelExporter, PdfExporter],
    },
  ],
})
export class ReportsModule {}
