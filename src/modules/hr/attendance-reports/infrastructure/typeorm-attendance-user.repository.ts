/**
 * TypeOrmAttendanceUserRepository (INFRASTRUCTURE) — the device→employee registry over the existing
 * `employee` table (SUPPORTING_APIS_GUIDE §7). No new table: `userId` is `employee_code`.
 *
 * The upsert targets `uq_employee_company_code`, which is a PARTIAL unique index (`WHERE deleted_at IS
 * NULL`), so `ON CONFLICT` must name the same predicate for Postgres to match the index. A soft-deleted
 * employee therefore does not block re-enrolling the same code — a new row is created, which is the
 * correct behaviour: the old person left.
 *
 * `designation` uses `COALESCE(EXCLUDED.designation, employee.designation)` so a partial update (no
 * designation supplied → NULL passed) keeps the stored value instead of wiping it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { compareUserIds } from '../domain/attendance-rules';
import {
  AttendanceUserCreateDefaults,
  AttendanceUserDto,
  AttendanceUserRepository,
  UpsertAttendanceUserInput,
} from '../domain/ports/attendance-user.repository';

const SELECT_COLUMNS = `"id"::text      AS "id",
                        "employee_code" AS "userId",
                        "name"          AS "name",
                        "designation"   AS "designation",
                        "created_at"    AS "createdAt",
                        "updated_at"    AS "updatedAt"`;

@Injectable()
export class TypeOrmAttendanceUserRepository implements AttendanceUserRepository {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async list(companyId: string): Promise<AttendanceUserDto[]> {
    const rows: AttendanceUserDto[] = await getManager(this.dataSource).query(
      `SELECT ${SELECT_COLUMNS} FROM "employee"
        WHERE "company_id" = $1 AND "deleted_at" IS NULL`,
      [companyId],
    );
    // Sorted in Node so `9` precedes `10`; a plain SQL ORDER BY on a varchar would not.
    return rows.sort((a, b) => compareUserIds(a.userId, b.userId));
  }

  async upsert(
    companyId: string,
    input: UpsertAttendanceUserInput,
    defaults: AttendanceUserCreateDefaults,
  ): Promise<AttendanceUserDto> {
    const rows: AttendanceUserDto[] = await getManager(this.dataSource).query(
      `INSERT INTO "employee"
              ("id", "company_id", "employee_code", "name", "designation",
               "work_base", "wage_type", "wage_amount", "joining_date", "status")
       VALUES ($1, $2, $3, $4, COALESCE($5, $6), $7, $8, 0, CURRENT_DATE, 'ACTIVE')
       ON CONFLICT ("company_id", "employee_code") WHERE "deleted_at" IS NULL
       DO UPDATE SET "name"        = EXCLUDED."name",
                     -- NULL means "not supplied": keep what is already stored.
                     "designation" = COALESCE($5, "employee"."designation"),
                     "updated_at"  = now()
       RETURNING ${SELECT_COLUMNS}`,
      [
        this.ids.next(),
        companyId,
        input.userId,
        input.name,
        input.designation ?? null,
        defaults.designation,
        defaults.workBase,
        defaults.wageType,
      ],
    );
    return rows[0] as AttendanceUserDto;
  }
}
