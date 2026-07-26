/**
 * TypeOrmAttendanceConfigRepository (INFRASTRUCTURE) — CRUD for the three attendance-report config
 * tables. Enrols in the active UnitOfWork via `getManager`, so `replaceWeeklyHolidays` and the import
 * loop commit atomically when the caller wraps them in `uow.run`. Every statement is companyId-scoped.
 *
 * Upserts key on the per-company unique constraints the migration declares
 * (`uq_attendance_setting_company`, `uq_weekly_holiday_company_weekday`,
 * `uq_government_holiday_company_date`), so a concurrent write collides in the DB rather than racing
 * to insert a duplicate.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { GovernmentHolidayDto, HolidaySource } from '../domain/holiday-rules';
import {
  AttendanceConfigRepository,
  StoredAttendanceSetting,
  UpsertGovernmentHolidayInput,
} from '../domain/ports/attendance-config.repository';

@Injectable()
export class TypeOrmAttendanceConfigRepository implements AttendanceConfigRepository {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async findSetting(companyId: string): Promise<StoredAttendanceSetting | null> {
    const rows: Array<{ lateAfterHour: number; lateAfterMinute: number; updatedAt: Date }> =
      await getManager(this.dataSource).query(
        `SELECT "late_after_hour"::int   AS "lateAfterHour",
                "late_after_minute"::int AS "lateAfterMinute",
                "updated_at"             AS "updatedAt"
           FROM "attendance_setting"
          WHERE "company_id" = $1
          LIMIT 1`,
        [companyId],
      );
    return rows[0] ?? null;
  }

  async upsertSetting(
    companyId: string,
    lateAfterHour: number,
    lateAfterMinute: number,
  ): Promise<StoredAttendanceSetting> {
    const rows: Array<{ lateAfterHour: number; lateAfterMinute: number; updatedAt: Date }> =
      await getManager(this.dataSource).query(
        `INSERT INTO "attendance_setting" ("id", "company_id", "late_after_hour", "late_after_minute")
              VALUES ($1, $2, $3, $4)
         ON CONFLICT ("company_id") DO UPDATE
                SET "late_after_hour"   = EXCLUDED."late_after_hour",
                    "late_after_minute" = EXCLUDED."late_after_minute",
                    "updated_at"        = now()
           RETURNING "late_after_hour"::int   AS "lateAfterHour",
                     "late_after_minute"::int AS "lateAfterMinute",
                     "updated_at"             AS "updatedAt"`,
        [this.ids.next(), companyId, lateAfterHour, lateAfterMinute],
      );
    return rows[0] as StoredAttendanceSetting;
  }

  async listWeeklyHolidays(companyId: string): Promise<number[]> {
    const rows: Array<{ weekday: number }> = await getManager(this.dataSource).query(
      `SELECT "weekday"::int AS "weekday"
         FROM "weekly_holiday"
        WHERE "company_id" = $1
        ORDER BY "weekday" ASC`,
      [companyId],
    );
    return rows.map((r) => r.weekday);
  }

  async replaceWeeklyHolidays(companyId: string, weekdays: readonly number[]): Promise<number[]> {
    const manager = getManager(this.dataSource);
    // Delete-then-insert rather than diffing: `PUT /weekly` is a full replace, and an empty list must
    // clear the table. `= ANY('{}')` is never true, so the guard degrades correctly for [].
    await manager.query(
      `DELETE FROM "weekly_holiday" WHERE "company_id" = $1 AND NOT ("weekday" = ANY($2::int[]))`,
      [companyId, [...weekdays]],
    );
    for (const weekday of weekdays) {
      await manager.query(
        `INSERT INTO "weekly_holiday" ("id", "company_id", "weekday") VALUES ($1, $2, $3)
         ON CONFLICT ("company_id", "weekday") DO NOTHING`,
        [this.ids.next(), companyId, weekday],
      );
    }
    return this.listWeeklyHolidays(companyId);
  }

  async listGovernmentHolidays(companyId: string, year: number): Promise<GovernmentHolidayDto[]> {
    return getManager(this.dataSource).query(
      `SELECT "id"::text                   AS "id",
              to_char("date", 'YYYY-MM-DD') AS "date",
              "name"                        AS "name",
              "local_name"                  AS "localName",
              "source"                      AS "source"
         FROM "government_holiday"
        WHERE "company_id" = $1
          AND "date" >= make_date($2, 1, 1)
          AND "date" <= make_date($2, 12, 31)
        ORDER BY "date" ASC`,
      [companyId, year],
    ) as Promise<GovernmentHolidayDto[]>;
  }

  async upsertGovernmentHoliday(
    companyId: string,
    input: UpsertGovernmentHolidayInput,
  ): Promise<GovernmentHolidayDto> {
    const rows: GovernmentHolidayDto[] = await getManager(this.dataSource).query(
      `INSERT INTO "government_holiday" ("id", "company_id", "date", "name", "local_name", "source")
            VALUES ($1, $2, $3::date, $4, $5, $6)
       ON CONFLICT ("company_id", "date") DO UPDATE
              SET "name"       = EXCLUDED."name",
                  "local_name" = EXCLUDED."local_name",
                  "source"     = EXCLUDED."source",
                  "updated_at" = now()
         RETURNING "id"::text                   AS "id",
                   to_char("date", 'YYYY-MM-DD') AS "date",
                   "name"                        AS "name",
                   "local_name"                  AS "localName",
                   "source"                      AS "source"`,
      [this.ids.next(), companyId, input.date, input.name, input.localName, input.source],
    );
    return rows[0] as GovernmentHolidayDto;
  }

  async findGovernmentHolidaySource(
    companyId: string,
    date: string,
  ): Promise<HolidaySource | null> {
    const rows: Array<{ source: HolidaySource }> = await getManager(this.dataSource).query(
      `SELECT "source" AS "source" FROM "government_holiday"
        WHERE "company_id" = $1 AND "date" = $2::date LIMIT 1`,
      [companyId, date],
    );
    return rows[0]?.source ?? null;
  }

  async deleteGovernmentHoliday(companyId: string, id: string): Promise<boolean> {
    const res: [unknown[], number] = await getManager(this.dataSource).query(
      `DELETE FROM "government_holiday" WHERE "company_id" = $1 AND "id" = $2::uuid`,
      [companyId, id],
    );
    // node-postgres returns [rows, rowCount] for a DELETE issued through TypeORM's raw query.
    return (res[1] ?? 0) > 0;
  }
}
