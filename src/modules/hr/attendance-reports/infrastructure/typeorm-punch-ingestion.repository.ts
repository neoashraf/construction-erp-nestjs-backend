/**
 * TypeOrmPunchIngestionRepository (INFRASTRUCTURE) — stores raw device punches and reconciles them into
 * the OFFICE `attendance_record` rows the reports read (SUPPORTING_APIS_GUIDE §5.4).
 *
 * `insertPunches` uses ON CONFLICT DO NOTHING against `uq_checkin_log_company_user_ts`, so a device that
 * re-sends a batch (they do, on any non-`OK` response) adds nothing the second time.
 *
 * `reconcileDays` is the bridge that makes device data visible to `/api/reports/*`. For each touched
 * employee-day it computes first/last punch from `checkin_log` and upserts the OFFICE row. Three guards:
 *   - unknown `employee_code` → skipped and reported, never invented;
 *   - no project (punch-stated, then device default, then employee default) → skipped:
 *     `attendance_record.project_id` is NOT NULL and guessing a project would corrupt job costing;
 *   - a CONFIRMED row is never touched — that attendance has already been posted to the ledger, and
 *     posted work is corrected by reverse-and-repost, not by an overwrite (CLAUDE.md non-negotiable 4).
 * `day_status` is set to PRESENT only when the row is created; an existing row's leave status is left
 * alone so a device punch cannot silently overwrite an approved PAID_LEAVE.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import {
  DeviceMapping,
  PunchIngestionRepository,
  PunchToStore,
  ReconcileOutcome,
} from '../domain/ports/punch-ingestion.repository';

@Injectable()
export class TypeOrmPunchIngestionRepository implements PunchIngestionRepository {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async findDeviceMapping(deviceSn: string | null): Promise<DeviceMapping | null> {
    if (!deviceSn) return null;
    const rows: Array<{ companyId: string; defaultProjectId: string | null }> = await getManager(
      this.dataSource,
    ).query(
      `SELECT "company_id"::text         AS "companyId",
              "default_project_id"::text AS "defaultProjectId"
         FROM "attendance_device"
        WHERE "device_sn" = $1 AND "is_active" = true
        LIMIT 1`,
      [deviceSn],
    );
    return rows[0] ?? null;
  }

  async autoRegisterDevice(deviceSn: string, companyId: string): Promise<DeviceMapping | null> {
    const manager = getManager(this.dataSource);

    // Guard against a stale DEVICE_DEFAULT_COMPANY_ID creating an orphaned device row.
    const company: Array<{ id: string }> = await manager.query(
      `SELECT "id"::text AS "id" FROM "company" WHERE "id" = $1 LIMIT 1`,
      [companyId],
    );
    if (!company[0]) return null;

    // Concurrent first punches race here, so the insert must tolerate losing that race.
    await manager.query(
      `INSERT INTO "attendance_device"
              ("id", "company_id", "device_sn", "label", "is_active", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, true, now(), now())
       ON CONFLICT ("device_sn") DO NOTHING`,
      [this.ids.next(), companyId, deviceSn, `Auto-registered ${deviceSn}`],
    );

    // Re-read rather than trusting RETURNING: on a lost race DO NOTHING returns no row, but
    // the mapping the winner created is the one we want.
    return this.findDeviceMapping(deviceSn);
  }

  async findCompanyDefaultProject(companyId: string): Promise<string | null> {
    const rows: Array<{ defaultProjectId: string | null }> = await getManager(this.dataSource).query(
      `SELECT "default_project_id"::text AS "defaultProjectId"
         FROM "attendance_device"
        WHERE "company_id" = $1 AND "is_active" = true AND "default_project_id" IS NOT NULL
        ORDER BY "created_at"
        LIMIT 1`,
      [companyId],
    );
    return rows[0]?.defaultProjectId ?? null;
  }

  async resolveProjectsByLocation(
    companyId: string,
    locations: readonly string[],
  ): Promise<Map<string, string>> {
    const wanted = [...new Set(locations.map((l) => l.trim().toLowerCase()).filter(Boolean))];
    if (wanted.length === 0) return new Map();

    // CODE first, then NAME — a code is the deliberate identifier, a name is the friendly label, so
    // a project whose NAME happens to equal another project's CODE must never win. Ordering the
    // union by rank and taking the first per key encodes that precedence in SQL.
    const rows: Array<{ key: string; projectId: string }> = await getManager(this.dataSource).query(
      `SELECT DISTINCT ON ("key") "key", "projectId"
         FROM (
           SELECT lower(trim("project_code")) AS "key", "id"::text AS "projectId", 1 AS "rank"
             FROM "project" WHERE "company_id" = $1
           UNION ALL
           SELECT lower(trim("name")) AS "key", "id"::text AS "projectId", 2 AS "rank"
             FROM "project" WHERE "company_id" = $1
         ) AS "candidates"
        WHERE "key" = ANY($2::text[])
        ORDER BY "key", "rank"`,
      [companyId, wanted],
    );

    return new Map(rows.map((r) => [r.key, r.projectId]));
  }

  async insertPunches(companyId: string, punches: readonly PunchToStore[]): Promise<number> {
    if (punches.length === 0) return 0;
    const manager = getManager(this.dataSource);
    let inserted = 0;
    for (const punch of punches) {
      // `RETURNING id` is what makes the count real. TypeORM's `query()` resolves an INSERT to
      // a bare `[]` — NOT the `[rows, rowCount]` tuple the pg driver exposes — so reading
      // `res[1]` yielded `undefined` and every insert counted as zero. The effect was silent
      // and cosmetic-looking but genuinely misleading: a sync that stored hundreds of new
      // punches reported "0 new punches", making a working sync look like a no-op. With
      // RETURNING, a real insert yields one row and a conflict-skip yields none, so the length
      // IS the count.
      const rows: Array<{ id: string }> = await manager.query(
        `INSERT INTO "checkin_log"
                ("id", "company_id", "source_type", "user_id", "device_timestamp", "status",
                 "device_sn", "occurred_at", "project_id")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT ("company_id", "user_id", "device_timestamp") DO NOTHING
         RETURNING "id"`,
        [
          this.ids.next(),
          companyId,
          punch.sourceType,
          punch.userId,
          punch.deviceTimestamp,
          punch.status,
          punch.deviceSn,
          punch.occurredAt,
          punch.projectId,
        ],
      );
      inserted += rows.length;
    }
    return inserted;
  }

  async reconcileDays(
    companyId: string,
    defaultProjectId: string | null,
    days: ReadonlyArray<{ userId: string; attendanceDate: string }>,
  ): Promise<ReconcileOutcome> {
    const manager = getManager(this.dataSource);
    const outcome: ReconcileOutcome = { reconciled: 0, skipped: [] };

    for (const day of days) {
      const employees: Array<{ id: string; defaultProjectId: string | null }> = await manager.query(
        `SELECT "id"::text AS "id", "default_project_id"::text AS "defaultProjectId"
           FROM "employee"
          WHERE "company_id" = $1 AND "employee_code" = $2 AND "deleted_at" IS NULL
          LIMIT 1`,
        [companyId, day.userId],
      );
      const employee = employees[0];
      if (!employee) {
        outcome.skipped.push({ ...day, reason: 'UNKNOWN_EMPLOYEE_CODE' });
        continue;
      }

      // Resolution order — evidence before guesswork (design §5.1):
      //   1. a project stated on one of the day's punches (an explicit manual entry or an imported
      //      Location cell) — the operator said where this was;
      //   2. the device's default project — the punch physically happened at that machine;
      //   3. the employee's default project — a standing guess about where they usually work.
      // The LATEST stating punch wins, so an afternoon site visit outranks a morning office punch.
      // Previously the employee default outranked both, so a site engineer who walked into head
      // office and punched there had that day costed to their construction site.
      const stated: Array<{ projectId: string | null }> = await manager.query(
        `SELECT "project_id"::text AS "projectId"
           FROM "checkin_log"
          WHERE "company_id" = $1 AND "user_id" = $2
            AND substring("device_timestamp" from 1 for 10) = $3
            AND "project_id" IS NOT NULL
          ORDER BY "device_timestamp" DESC
          LIMIT 1`,
        [companyId, day.userId, day.attendanceDate],
      );
      const projectId = stated[0]?.projectId ?? defaultProjectId ?? employee.defaultProjectId;
      if (!projectId) {
        outcome.skipped.push({ ...day, reason: 'NO_PROJECT' });
        continue;
      }

      const years: Array<{ id: string }> = await manager.query(
        `SELECT "id"::text AS "id" FROM "financial_year"
          WHERE "company_id" = $1 AND "deleted_at" IS NULL
            AND $2::date BETWEEN "start_date" AND "end_date"
          LIMIT 1`,
        [companyId, day.attendanceDate],
      );
      const financialYearId = years[0]?.id;
      if (!financialYearId) {
        outcome.skipped.push({ ...day, reason: 'NO_FINANCIAL_YEAR' });
        continue;
      }

      // First/last punch of the day. device_timestamp is zero-padded text, so MIN/MAX are chronological.
      const bounds: Array<{ checkIn: string | null; checkOut: string | null }> = await manager.query(
        `SELECT substring(MIN("device_timestamp") from 12 for 8) AS "checkIn",
                substring(MAX("device_timestamp") from 12 for 8) AS "checkOut"
           FROM "checkin_log"
          WHERE "company_id" = $1 AND "user_id" = $2
            AND substring("device_timestamp" from 1 for 10) = $3`,
        [companyId, day.userId, day.attendanceDate],
      );
      const checkIn = bounds[0]?.checkIn ?? null;
      const checkOut = bounds[0]?.checkOut ?? null;
      if (!checkIn) continue; // nothing to fold

      const existing: Array<{ id: string; isConfirmed: boolean }> = await manager.query(
        `SELECT "id"::text AS "id", "is_confirmed" AS "isConfirmed"
           FROM "attendance_record"
          WHERE "company_id" = $1 AND "employee_id" = $2::uuid
            AND "attendance_date" = $3::date AND "mode" = 'OFFICE'
          LIMIT 1`,
        [companyId, employee.id, day.attendanceDate],
      );

      if (existing[0]) {
        if (existing[0].isConfirmed) {
          // Posted attendance is immutable — corrections go through reverse-and-repost, not an update.
          outcome.skipped.push({ ...day, reason: 'ALREADY_CONFIRMED' });
          continue;
        }
        // day_status is intentionally NOT overwritten: an approved PAID_LEAVE must survive a stray punch.
        await manager.query(
          `UPDATE "attendance_record"
              SET "check_in" = $1::time, "check_out" = $2::time,
                  "source" = 'BIOMETRIC_IMPORT', "updated_at" = now()
            WHERE "id" = $3::uuid`,
          [checkIn, checkOut, existing[0].id],
        );
      } else {
        await manager.query(
          `INSERT INTO "attendance_record"
                  ("id", "company_id", "financial_year_id", "mode", "attendance_date", "project_id",
                   "employee_id", "check_in", "check_out", "day_status", "overtime_hours", "source")
           VALUES ($1, $2, $3, 'OFFICE', $4::date, $5::uuid, $6::uuid, $7::time, $8::time,
                   'PRESENT', 0, 'BIOMETRIC_IMPORT')`,
          [
            this.ids.next(),
            companyId,
            financialYearId,
            day.attendanceDate,
            projectId,
            employee.id,
            checkIn,
            checkOut,
          ],
        );
      }
      outcome.reconciled += 1;
    }

    return outcome;
  }

  async findLatestPunch(
    companyId: string,
  ): Promise<{ deviceTimestamp: string; receivedAt: Date } | null> {
    const rows: Array<{ deviceTimestamp: string; receivedAt: Date }> = await getManager(
      this.dataSource,
    ).query(
      `SELECT "device_timestamp" AS "deviceTimestamp", "received_at" AS "receivedAt"
         FROM "checkin_log" WHERE "company_id" = $1
        ORDER BY "received_at" DESC LIMIT 1`,
      [companyId],
    );
    return rows[0] ?? null;
  }

  async listPunchDays(
    companyId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<Array<{ userId: string; attendanceDate: string }>> {
    // device_timestamp is zero-padded text, so a lexicographic BETWEEN over the day boundaries is also
    // a chronological range — no cast, and the (company, user, ts) index still applies.
    return getManager(this.dataSource).query(
      `SELECT DISTINCT "user_id" AS "userId",
              substring("device_timestamp" from 1 for 10) AS "attendanceDate"
         FROM "checkin_log"
        WHERE "company_id" = $1
          AND "device_timestamp" >= $2 AND "device_timestamp" <= $3
        ORDER BY 1, 2`,
      [companyId, `${dateFrom} 00:00:00`, `${dateTo} 23:59:59`],
    ) as Promise<Array<{ userId: string; attendanceDate: string }>>;
  }

  async touchDeviceLastSeen(deviceSn: string, seenAt: Date): Promise<void> {
    await getManager(this.dataSource).query(
      `UPDATE "attendance_device" SET "last_seen_at" = $2, "updated_at" = now() WHERE "device_sn" = $1`,
      [deviceSn, seenAt],
    );
  }
}
