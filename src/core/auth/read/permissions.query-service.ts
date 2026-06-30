/** Permissions read service (AUD read/ — FR-AUD-012/013). */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';

@Injectable()
export class PermissionsQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async findAll(companyId: string, filters: { roleId?: string; module?: string; action?: string; page: number; pageSize: number }) {
    const conditions: string[] = ['company_id = $1'];
    const params: any[] = [companyId];
    let p = 2;
    if (filters.roleId) { conditions.push(`role_id = $${p++}`); params.push(filters.roleId); }
    if (filters.module) { conditions.push(`module = $${p++}`); params.push(filters.module); }
    if (filters.action) { conditions.push(`action = $${p++}`); params.push(filters.action); }
    const where = conditions.join(' AND ');
    const offset = (filters.page - 1) * filters.pageSize;

    const [rows, countRows] = await Promise.all([
      this.ds.query(
        `SELECT id, role_id AS "roleId", module, action, project_scope AS "projectScope", value_limit::text AS "valueLimit"
         FROM "permission" WHERE ${where} ORDER BY module, action LIMIT $${p} OFFSET $${p + 1}`,
        [...params, filters.pageSize, offset],
      ),
      this.ds.query(`SELECT COUNT(*)::int AS total FROM "permission" WHERE ${where}`, params),
    ]);
    return { items: rows, total: countRows[0]?.total ?? 0 };
  }
}
