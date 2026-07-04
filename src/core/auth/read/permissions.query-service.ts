/** Permissions read service (AUD read/ — FR-AUD-012/013/035). */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { RESOURCE_CATALOG } from '../domain/resource-catalog';

@Injectable()
export class PermissionsQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  /** GET /api/permissions/catalog — the Resource Catalogue the editor renders (FR-AUD-035). */
  catalog() {
    return {
      modules: RESOURCE_CATALOG.map(m => ({
        module: m.module,
        label: m.label,
        resources: m.resources.map(r => ({ resource: r.resource, label: r.label, actions: [...r.actions] })),
      })),
    };
  }

  async findAll(companyId: string, filters: { roleId?: string; resource?: string; action?: string; page: number; pageSize: number }) {
    const conditions: string[] = ['company_id = $1'];
    const params: any[] = [companyId];
    let p = 2;
    if (filters.roleId) { conditions.push(`role_id = $${p++}`); params.push(filters.roleId); }
    if (filters.resource) { conditions.push(`resource = $${p++}`); params.push(filters.resource); }
    if (filters.action) { conditions.push(`action = $${p++}`); params.push(filters.action); }
    const where = conditions.join(' AND ');
    const offset = (filters.page - 1) * filters.pageSize;

    const [rows, countRows] = await Promise.all([
      this.ds.query(
        `SELECT id, role_id AS "roleId", resource, action, project_scope AS "projectScope", value_limit::text AS "valueLimit"
         FROM "permission" WHERE ${where} ORDER BY resource, action LIMIT $${p} OFFSET $${p + 1}`,
        [...params, filters.pageSize, offset],
      ),
      this.ds.query(`SELECT COUNT(*)::int AS total FROM "permission" WHERE ${where}`, params),
    ]);
    return { items: rows, total: countRows[0]?.total ?? 0 };
  }
}
