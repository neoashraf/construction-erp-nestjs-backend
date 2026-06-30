/** Roles read service (AUD read/ — FR-AUD-011/016). Direct SQL reads; no domain mapping. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';

@Injectable()
export class RolesQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async findAll(companyId: string) {
    const rows = await this.ds.query(
      `SELECT id, name, approval_limit::text AS "approvalLimit", is_unscoped AS "isUnscoped", version
       FROM "role" WHERE company_id = $1 ORDER BY name`,
      [companyId],
    );
    return rows.map((r: any) => ({ id: r.id, name: r.name, approvalLimit: r.approvalLimit ?? null, isUnscoped: r.isUnscoped, version: r.version }));
  }

  async findById(id: string, companyId: string) {
    const rows = await this.ds.query(
      `SELECT r.id, r.name, r.approval_limit::text AS "approvalLimit", r.is_unscoped AS "isUnscoped", r.version,
              p.id AS "permId", p.module, p.action, p.project_scope AS "projectScope", p.value_limit::text AS "valueLimit"
       FROM "role" r
       LEFT JOIN "permission" p ON p.role_id = r.id
       WHERE r.id = $1 AND r.company_id = $2`,
      [id, companyId],
    );
    if (rows.length === 0) return null;
    const first = rows[0];
    const permissions = rows
      .filter((r: any) => r.permId)
      .map((r: any) => ({ id: r.permId, module: r.module, action: r.action, projectScope: r.projectScope, valueLimit: r.valueLimit ?? null }));
    return { id: first.id, name: first.name, approvalLimit: first.approvalLimit ?? null, isUnscoped: first.isUnscoped, version: first.version, permissions };
  }
}
