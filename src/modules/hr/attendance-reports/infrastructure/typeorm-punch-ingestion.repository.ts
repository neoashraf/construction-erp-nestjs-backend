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
 *   - no project (employee default, then device default) → skipped: `attendance_record.project_id` is
 *     NOT NULL and guessing a project would corrupt job costing;
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

  async insertPunches(companyId: string, punches: readonly PunchToStore[]): Promise<number> {
    if (punches.length === 0) return 0;
    const manager = getManager(this.dataSource);
    let inserted = 0;
    for (const punch of punches) {
      const res: [unknown[], number] = await manager.query(
        `INSERT INTO "checkin_log"
                ("id", "company_id", "source_type", "user_id", "device_timestamp", "status",
                 "device_sn", "occurred_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT ("company_id", "user_id", "device_timestamp") DO NOTHING`,
        [
          this.ids.next(),
          companyId,
          punch.sourceType,
          punch.userId,
          punch.deviceTimestamp,
          punch.status,
          punch.deviceSn,
          punch.occurredAt,
        ],
      );
      inserted += res[1] ?? 0;
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

      const projectId = employee.defaultProjectId ?? defaultProjectId;
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
