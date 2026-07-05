/**
 * SqlRecipientResolver (NTF INFRASTRUCTURE — FR-NTF-017/018/020). Resolves a catalogue recipient rule
 * to active recipient user ids by reading AUD's live `user` / `user_project` tables (company-scoped).
 * Inactive users are excluded; NTF keeps no copy of roles or assignments.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { RecipientResolver, RecipientContext } from '../domain/ports/recipient-resolver.port';
import { RecipientRule } from '../domain/notification-catalog';

@Injectable()
export class SqlRecipientResolver implements RecipientResolver {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async resolve(rule: RecipientRule, ctx: RecipientContext): Promise<string[]> {
    if (rule.kind === 'USER') {
      if (!ctx.affectedUserId) return [];
      const rows = await this.ds.query(
        `SELECT id FROM "user" WHERE id = $1 AND company_id = $2 AND is_active = true`,
        [ctx.affectedUserId, ctx.companyId],
      );
      return rows.map((r: any) => r.id);
    }

    if (rule.kind === 'ROLE') {
      const rows = await this.ds.query(
        `SELECT id FROM "user" WHERE company_id = $1 AND role = ANY($2) AND is_active = true`,
        [ctx.companyId, rule.roles],
      );
      return rows.map((r: any) => r.id);
    }

    // PROJECT_ROLE — active holders of the role(s) ASSIGNED to this project.
    if (!ctx.projectId) return [];
    const rows = await this.ds.query(
      `SELECT DISTINCT u.id
       FROM "user" u JOIN user_project up ON up.user_id = u.id
       WHERE u.company_id = $1 AND u.role = ANY($2) AND up.project_id = $3 AND u.is_active = true`,
      [ctx.companyId, rule.roles, ctx.projectId],
    );
    return rows.map((r: any) => r.id);
  }
}
