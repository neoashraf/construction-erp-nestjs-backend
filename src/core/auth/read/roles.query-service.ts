/** Roles read service (AUD read/ — FR-AUD-011/016/034). Direct SQL reads; no domain mapping. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';

@Injectable()
export class RolesQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async findAll(companyId: string) {
    const rows = await this.ds.query(
      `SELECT r.id, r.name, r.is_system AS "isSystem",
              r.approval_limit::text AS "approvalLimit", r.is_unscoped AS "isUnscoped", r.version,
              (SELECT COUNT(*)::int FROM "user" u WHERE u.company_id = r.company_id AND u.role = r.name) AS "userCount"
       FROM "role" r WHERE r.company_id = $1 ORDER BY r.is_system DESC, r.name`,
      [companyId],
    );
    return rows.map((r: any) => ({
      id: r.id, name: r.name, isSystem: r.isSystem,
      approvalLimit: r.approvalLimit ?? null, isUnscoped: r.isUnscoped, userCount: r.userCount, version: r.version,
    }));
  }

  async findById(id: string, companyId: string) {
    const rows = await this.ds.query(
      `SELECT r.id, r.name, r.is_system AS "isSystem", r.approval_limit::text AS "approvalLimit",
              r.is_unscoped AS "isUnscoped", r.version,
              (SELECT COUNT(*)::int FROM "user" u WHERE u.company_id = r.company_id AND u.role = r.name) AS "userCount",
              p.id AS "permId", p.resource, p.action, p.project_scope AS "projectScope", p.value_limit::text AS "valueLimit"
       FROM "role" r
       LEFT JOIN "permission" p ON p.role_id = r.id
       WHERE r.id = $1 AND r.company_id = $2`,
      [id, companyId],
    );
    if (rows.length === 0) return null;
    const first = rows[0];
    const permissions = rows
      .filter((r: any) => r.permId)
      .map((r: any) => ({ id: r.permId, resource: r.resource, action: r.action, projectScope: r.projectScope, valueLimit: r.valueLimit ?? null }));
    return {
      id: first.id, name: first.name, isSystem: first.isSystem, approvalLimit: first.approvalLimit ?? null,
      isUnscoped: first.isUnscoped, userCount: first.userCount, version: first.version, permissions,
    };
  }
}
