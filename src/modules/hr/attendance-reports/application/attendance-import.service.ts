/**
 * AttendanceImportService — the THIRD ingestion path, alongside push (`/iclock/cdata`) and
 * pull (`POST /api/sync`).
 *
 * It deliberately owns no storage logic of its own. Rows are normalised to punches, then
 * handed to the SAME `insertPunches` → `reconcileDays` pair the device paths use. That is
 * what makes "import now, sync later" safe:
 *
 *   - `insertPunches` dedupes on `(company, user_id, device_timestamp)`, so a day imported
 *     from a spreadsheet and then reported by the device stores once, not twice. Whichever
 *     arrives second is a no-op.
 *   - `reconcileDays` recomputes each touched day as MIN/MAX over ALL punches for that day,
 *     regardless of which path delivered them. An imported 09:05 check-in and a device 18:10
 *     check-out merge into one correct day rather than fighting.
 *   - A CONFIRMED attendance row is skipped by the same guard as everywhere else: posted
 *     attendance is immutable (CLAUDE.md non-negotiable 4), so an import can never quietly
 *     rewrite payroll that has already been through the ledger.
 *
 * Because of that, importing the same file twice is a no-op rather than a doubling — which is
 * the property that actually matters to an operator who is unsure whether the first attempt
 * went through.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import {
  parseImportRows,
  type ImportRowError,
  type RawImportRow,
} from '../domain/attendance-import.parser';
import { badRequest } from '../domain/attendance-rules';
import { parseDeviceTimestamp, punchDayKey } from '../domain/punch-payload.parser';
import {
  PUNCH_INGESTION_REPOSITORY,
  type PunchIngestionRepository,
  type PunchToStore,
  type ReconcileOutcome,
} from '../domain/ports/punch-ingestion.repository';

/**
 * Upper bound on one upload.
 *
 * A month of two punches a day for ~500 staff is ~30k rows, so this leaves real headroom
 * while still refusing a file that would hold a transaction open long enough to matter.
 * Reconciliation is per-employee-day and issues several queries each, so the cost is in the
 * DAYS touched, not the row count — hence the separate, tighter day guard below.
 */
const MAX_ROWS = 20_000;

/** Distinct employee-days one import may reconcile; see `MAX_ROWS` for why this is separate. */
const MAX_DAYS = 10_000;

/** Marks these punches as spreadsheet-sourced in `checkin_log.source_type`, for audit. */
const SOURCE_TYPE = 'EXCEL_IMPORT';

export interface ImportResult {
  /** Data rows that produced at least one punch. */
  acceptedRows: number;
  /** Entirely-empty rows, skipped silently. */
  blankRows: number;
  /** Punches derived from the accepted rows (a row yields one or two). */
  punches: number;
  /** Punches newly written; the rest were already stored by an earlier import or the device. */
  inserted: number;
  /** Punches already present — proof that a re-import did not double anything. */
  duplicates: number;
  /** Employee-days folded into `attendance_record`. */
  reconciled: number;
  /** Why days could not be folded, counted by reason (`NO_FINANCIAL_YEAR`, `NO_PROJECT`, …). */
  skippedReasons: Record<string, number>;
  /** Per-row rejections, with sheet row numbers. */
  errors: ImportRowError[];
}

@Injectable()
export class AttendanceImportService {
  private readonly logger = new Logger(AttendanceImportService.name);

  constructor(
    @Inject(PUNCH_INGESTION_REPOSITORY) private readonly punches: PunchIngestionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async import(
    companyId: string,
    defaultProjectId: string | null,
    rows: readonly RawImportRow[],
  ): Promise<ImportResult> {
    if (rows.length === 0) throw badRequest('No rows to import');
    if (rows.length > MAX_ROWS) {
      throw badRequest(`Too many rows (${rows.length}). Split the file into batches of ${MAX_ROWS}.`);
    }

    const parsed = parseImportRows(rows);

    // Every usable row failed validation — report the reasons rather than an empty success,
    // which would read as "the file imported and contained nothing".
    if (parsed.punches.length === 0) {
      return {
        acceptedRows: 0,
        blankRows: parsed.blankRows,
        punches: 0,
        inserted: 0,
        duplicates: 0,
        reconciled: 0,
        skippedReasons: {},
        errors: parsed.errors,
      };
    }

    // Resolve the sheet's `Location` cells to project ids before building the batch. A cell that
    // names no project is a per-row error exactly like a bad date — the rest of the file still
    // imports, and the operator is told which rows to fix rather than being left to bisect.
    const stated = parsed.punches.map((p) => p.location).filter((l): l is string => l !== null);
    const projectsByLocation = await this.punches.resolveProjectsByLocation(companyId, stated);
    const locationErrors: ImportRowError[] = [];
    const rejectedRows = new Set<number>();
    for (const punch of parsed.punches) {
      if (punch.location === null) continue;
      if (projectsByLocation.has(punch.location.trim().toLowerCase())) continue;
      if (rejectedRows.has(punch.row)) continue; // one error per sheet row, not per punch
      rejectedRows.add(punch.row);
      locationErrors.push({
        row: punch.row,
        message: `Unknown location '${punch.location}' — expected a project code or name`,
      });
    }

    // Dedupe within the file itself before touching the DB — the same punch listed twice in
    // one sheet must not be counted as an insert and then a duplicate of itself.
    const unique = new Map<string, PunchToStore>();
    for (const punch of parsed.punches) {
      if (rejectedRows.has(punch.row)) continue;
      unique.set(`${punch.userId}|${punch.deviceTimestamp}`, {
        sourceType: SOURCE_TYPE,
        userId: punch.userId,
        deviceTimestamp: punch.deviceTimestamp,
        status: punch.status,
        occurredAt: parseDeviceTimestamp(punch.deviceTimestamp),
        deviceSn: null,
        // Rank 1 of the resolution order when the sheet stated a location; NULL (not stated) when it
        // did not, which is byte-identical to how every sheet imported before this column existed.
        projectId:
          punch.location === null
            ? null
            : (projectsByLocation.get(punch.location.trim().toLowerCase()) ?? null),
      });
    }

    // Sheet order, so the operator reads the errors in the order the rows appear in Excel.
    const errors = [...parsed.errors, ...locationErrors].sort((a, b) => a.row - b.row);
    const acceptedRows = parsed.acceptedRows - rejectedRows.size;

    const batch = [...unique.values()];
    if (batch.length === 0) {
      return {
        acceptedRows: 0,
        blankRows: parsed.blankRows,
        punches: 0,
        inserted: 0,
        duplicates: 0,
        reconciled: 0,
        skippedReasons: {},
        errors,
      };
    }

    const days = new Map<string, { userId: string; attendanceDate: string }>();
    for (const punch of batch) {
      const day = punchDayKey(punch.deviceTimestamp);
      if (!day) continue;
      days.set(`${punch.userId}|${day}`, { userId: punch.userId, attendanceDate: day });
    }

    if (days.size > MAX_DAYS) {
      throw badRequest(
        `Too many employee-days (${days.size}). Split the file into smaller date ranges.`,
      );
    }

    return this.uow.run(async () => {
      const inserted = await this.punches.insertPunches(companyId, batch);
      const outcome = await this.punches.reconcileDays(companyId, defaultProjectId, [
        ...days.values(),
      ]);

      const skippedReasons = this.countReasons(outcome);

      // Rows stored but nothing reconciled means the import will not appear in any report —
      // the failure most easily mistaken for success, so it is logged at error level.
      if (outcome.reconciled === 0 && outcome.skipped.length > 0) {
        this.logger.error(
          `Excel import stored punches but reconciled NOTHING — ` +
            `${Object.entries(skippedReasons)
              .map(([reason, n]) => `${reason}×${n}`)
              .join(', ')}. These punches will not appear in attendance reports until fixed.`,
        );
      } else {
        this.logger.log(
          `Excel import: ${acceptedRows} row(s) → ${batch.length} punch(es), ` +
            `+${inserted} stored (${batch.length - inserted} dup), reconciled ${outcome.reconciled}`,
        );
      }

      return {
        acceptedRows,
        blankRows: parsed.blankRows,
        punches: batch.length,
        inserted,
        duplicates: batch.length - inserted,
        reconciled: outcome.reconciled,
        skippedReasons,
        errors,
      };
    });
  }

  private countReasons(outcome: ReconcileOutcome): Record<string, number> {
    const reasons: Record<string, number> = {};
    for (const entry of outcome.skipped) {
      reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
    }
    return reasons;
  }
}
