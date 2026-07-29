/**
 * AttendanceLogReadAdapter (INFRASTRUCTURE) — raw punches for `GET /api/logs` (SUPPORTING_APIS_GUIDE §2).
 *
 * `device_timestamp` is zero-padded text, so the window filter is a plain lexicographic BETWEEN over
 * `'YYYY-MM-DD 00:00:00'`..`'YYYY-MM-DD 23:59:59'` — chronological without a cast, and the
 * `(company_id, user_id, device_timestamp)` index covers it.
 *
 * Unlike the reports adapter this does NOT aggregate: `/api/logs` reports per-punch ids and
 * `punchCount`, so the service groups by day in Node. That is the source contract's shape, and the row
 * count is bounded by the page of employees the caller asked for.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { AttendanceLogReadPort, PunchRow } from '../domain/ports/attendance-log.read.port';

@Injectable()
export class AttendanceLogReadAdapter implements AttendanceLogReadPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async listPunches(
    companyId: string,
    employeeCodes: readonly string[],
    dateFrom: string,
    dateTo: string,
  ): Promise<PunchRow[]> {
    if (employeeCodes.length === 0) return [];

    // The LEFT JOIN (not an inner join) is load-bearing: `project_id` is nullable — a device punch
    // states no project — and an inner join would silently drop exactly those punches from the day.
    return getManager(this.dataSource).query(
      `SELECT c."id"::text          AS "id",
              c."user_id"           AS "userId",
              c."device_timestamp"  AS "deviceTimestamp",
              c."received_at"       AS "receivedAt",
              c."source_type"       AS "sourceType",
              c."project_id"::text  AS "projectId",
              p."name"              AS "projectName"
         FROM "checkin_log" c
         LEFT JOIN "project" p ON p."id" = c."project_id"
        WHERE c."company_id" = $1
          AND c."user_id" = ANY($2::varchar[])
          AND c."device_timestamp" >= $3 AND c."device_timestamp" <= $4
        ORDER BY c."user_id" ASC, c."device_timestamp" ASC`,
      [companyId, [...employeeCodes], `${dateFrom} 00:00:00`, `${dateTo} 23:59:59`],
    ) as Promise<PunchRow[]>;
  }
}
