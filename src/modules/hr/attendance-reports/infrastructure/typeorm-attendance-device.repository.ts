/**
 * TypeOrmAttendanceDeviceRepository (INFRASTRUCTURE) — CRUD over `attendance_device`.
 *
 * Every statement is company-scoped in its WHERE clause (not just filtered after the fact), so a
 * guessed or stale id from another tenant returns "not found" rather than another company's row.
 * The one deliberate exception is `findBySerialAnyCompany` — see the port's note on the global
 * UNIQUE constraint.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import {
  AttendanceDeviceDto,
  AttendanceDeviceRepository,
  CreateAttendanceDeviceInput,
  UpdateAttendanceDeviceInput,
} from '../domain/ports/attendance-device.repository';

/** Shared projection — the project name is joined here so the list needs no second query. */
const SELECT_DEVICE = `
  SELECT d."id"::text                 AS "id",
         d."device_sn"                AS "deviceSn",
         d."label"                    AS "label",
         d."default_project_id"::text AS "defaultProjectId",
         p."name"                     AS "defaultProjectName",
         d."is_active"                AS "isActive",
         d."last_seen_at"             AS "lastSeenAt",
         d."created_at"               AS "createdAt"
    FROM "attendance_device" d
    LEFT JOIN "project" p ON p."id" = d."default_project_id"
`;

@Injectable()
export class TypeOrmAttendanceDeviceRepository implements AttendanceDeviceRepository {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async list(companyId: string): Promise<AttendanceDeviceDto[]> {
    return getManager(this.dataSource).query(
      `${SELECT_DEVICE} WHERE d."company_id" = $1 ORDER BY d."created_at"`,
      [companyId],
    );
  }

  async findById(companyId: string, id: string): Promise<AttendanceDeviceDto | null> {
    const rows: AttendanceDeviceDto[] = await getManager(this.dataSource).query(
      `${SELECT_DEVICE} WHERE d."company_id" = $1 AND d."id" = $2 LIMIT 1`,
      [companyId, id],
    );
    return rows[0] ?? null;
  }

  async findBySerialAnyCompany(deviceSn: string): Promise<{ companyId: string } | null> {
    const rows: Array<{ companyId: string }> = await getManager(this.dataSource).query(
      `SELECT "company_id"::text AS "companyId" FROM "attendance_device"
        WHERE "device_sn" = $1 LIMIT 1`,
      [deviceSn],
    );
    return rows[0] ?? null;
  }

  async create(
    companyId: string,
    input: CreateAttendanceDeviceInput,
  ): Promise<AttendanceDeviceDto> {
    const manager = getManager(this.dataSource);
    const id = this.ids.next();
    await manager.query(
      `INSERT INTO "attendance_device"
              ("id", "company_id", "device_sn", "label", "default_project_id",
               "is_active", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, $5, true, now(), now())`,
      [id, companyId, input.deviceSn, input.label, input.defaultProjectId],
    );
    // Re-read through the shared projection so the caller gets the joined project name.
    return (await this.findById(companyId, id)) as AttendanceDeviceDto;
  }

  async update(
    companyId: string,
    id: string,
    input: UpdateAttendanceDeviceInput,
  ): Promise<AttendanceDeviceDto | null> {
    // Build the SET list from PRESENT keys only: `undefined` means "not supplied" and must
    // leave the column alone, whereas an explicit `null` genuinely clears it. Collapsing the
    // two would wipe a project every time the toggle was flipped.
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`"${column}" = $${params.length}`);
    };

    if (input.label !== undefined) push('label', input.label);
    if (input.defaultProjectId !== undefined) push('default_project_id', input.defaultProjectId);
    if (input.isActive !== undefined) push('is_active', input.isActive);
    if (sets.length === 0) return this.findById(companyId, id);

    sets.push(`"updated_at" = now()`);
    params.push(companyId, id);

    const rows: Array<{ id: string }> = await getManager(this.dataSource).query(
      `UPDATE "attendance_device" SET ${sets.join(', ')}
        WHERE "company_id" = $${params.length - 1} AND "id" = $${params.length}
        RETURNING "id"`,
      params,
    );
    return rows[0] ? this.findById(companyId, id) : null;
  }

  async remove(companyId: string, id: string): Promise<boolean> {
    const rows: Array<{ id: string }> = await getManager(this.dataSource).query(
      `DELETE FROM "attendance_device"
        WHERE "company_id" = $1 AND "id" = $2
        RETURNING "id"`,
      [companyId, id],
    );
    return rows.length > 0;
  }

  async countPunches(companyId: string, deviceSn: string): Promise<number> {
    const rows: Array<{ count: string }> = await getManager(this.dataSource).query(
      `SELECT count(*)::text AS "count" FROM "checkin_log"
        WHERE "company_id" = $1 AND "device_sn" = $2`,
      [companyId, deviceSn],
    );
    return Number(rows[0]?.count ?? '0');
  }

  async listActiveForSync(): Promise<
    Array<{ companyId: string; deviceSn: string; defaultProjectId: string | null }>
  > {
    return getManager(this.dataSource).query(
      `SELECT "company_id"::text         AS "companyId",
              "device_sn"                AS "deviceSn",
              "default_project_id"::text AS "defaultProjectId"
         FROM "attendance_device"
        WHERE "is_active" = true
        ORDER BY "created_at"`,
    );
  }

  async projectExists(companyId: string, projectId: string): Promise<boolean> {
    const rows: Array<{ id: string }> = await getManager(this.dataSource).query(
      `SELECT "id"::text AS "id" FROM "project"
        WHERE "id" = $1 AND "company_id" = $2 LIMIT 1`,
      [projectId, companyId],
    );
    return rows.length > 0;
  }
}
