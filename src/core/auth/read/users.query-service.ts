/**
 * Users read service (AUD read/ — FR-AUD-011/015/018/027). Company-scoped; never exposes password_hash.
 * `roleId`/`roleIsSystem`/`roleIsUnscoped` are resolved by joining `role` on the denormalised
 * `user.role` name, so clients key on the stable role id instead of name-matching.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { Paginated } from '../../../infrastructure/http/pagination';

@Injectable()
export class UsersQueryService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async findAll(companyId: string, filters: { role?: string; isActive?: boolean; search?: string; page: number; pageSize: number }) {
    const conditions: string[] = ['u.company_id = $1'];
    const params: any[] = [companyId];
    let p = 2;
    if (filters.role) { conditions.push(`u.role = $${p++}`); params.push(filters.role); }
    if (filters.isActive !== undefined) { conditions.push(`u.is_active = $${p++}`); params.push(filters.isActive); }
    if (filters.search) { conditions.push(`(u.name ILIKE $${p} OR u.email ILIKE $${p})`); params.push(`%${filters.search}%`); p++; }
    const where = conditions.join(' AND ');
    const offset = (filters.page - 1) * filters.pageSize;

    const [rows, countRows] = await Promise.all([
      this.ds.query(
        `SELECT u.id, u.email, u.name, u.role, u.is_active AS "isActive", u.last_login_at AS "lastLoginAt",
                r.id AS "roleId", r.is_system AS "roleIsSystem", r.is_unscoped AS "roleIsUnscoped",
                (SELECT COUNT(*)::int FROM user_project up WHERE up.user_id = u.id) AS "assignedProjectCount"
         FROM "user" u
         LEFT JOIN "role" r ON r.name = u.role AND r.company_id = u.company_id
         WHERE ${where} ORDER BY u.name LIMIT $${p} OFFSET $${p + 1}`,
        [...params, filters.pageSize, offset],
      ),
      this.ds.query(`SELECT COUNT(*)::int AS total FROM "user" u WHERE ${where}`, params),
    ]);
    // Return a Paginated so the ResponseEnvelopeInterceptor lifts the rows to `data`
    // (array) and page info to `meta` — the central list envelope every other list
    // endpoint uses, and the shape both the user-management screen and the project
    // PM picker consume. A bare `{ items, total }` would be wrapped as
    // `{ data: { items, total } }`, leaving the client's `data` a non-array (empty list).
    return new Paginated<any>(rows, filters.page, filters.pageSize, countRows[0]?.total ?? 0);
  }

  async findById(id: string, companyId: string) {
    const [userRows, projRows] = await Promise.all([
      this.ds.query(
        `SELECT u.id, u.email, u.name, u.role, u.financial_year_id AS "financialYearId", u.is_active AS "isActive",
                u.last_login_at AS "lastLoginAt", u.must_change_password AS "mustChangePassword", u.phone, u.version,
                r.id AS "roleId", r.is_system AS "roleIsSystem", r.is_unscoped AS "roleIsUnscoped"
         FROM "user" u
         LEFT JOIN "role" r ON r.name = u.role AND r.company_id = u.company_id
         WHERE u.id = $1 AND u.company_id = $2`,
        [id, companyId],
      ),
      this.ds.query(
        `SELECT up.project_id AS "projectId", p.name AS "projectName"
         FROM user_project up
         JOIN project p ON p.id = up.project_id
         WHERE up.user_id = $1`,
        [id],
      ),
    ]);
    if (!userRows[0]) return null;
    return { ...userRows[0], assignedProjects: projRows };
  }

  async findProjectsForUser(userId: string, companyId: string) {
    const user = await this.ds.query(
      `SELECT u.role, r.is_unscoped AS "isUnscoped"
       FROM "user" u
       JOIN "role" r ON r.name = u.role AND r.company_id = u.company_id
       WHERE u.id = $1 AND u.company_id = $2`,
      [userId, companyId],
    );
    if (!user[0]) return null;
    if (user[0].isUnscoped) return { scope: 'ALL' };
    const rows = await this.ds.query(
      `SELECT up.project_id AS "projectId", p.name AS "projectName"
       FROM user_project up
       JOIN project p ON p.id = up.project_id
       WHERE up.user_id = $1`,
      [userId],
    );
    return rows;
  }
}
