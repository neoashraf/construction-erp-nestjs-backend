/** DbRefreshTokenStore (INFRASTRUCTURE) — server-side JTI allowlist in `refresh_token` table. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { RefreshTokenStore } from '../domain/ports/refresh-token-store.port';
import { RefreshTokenOrmEntity } from './refresh-token.orm-entity';

@Injectable()
export class DbRefreshTokenStore implements RefreshTokenStore {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  private repo() {
    return this.dataSource.getRepository(RefreshTokenOrmEntity);
  }

  async issue(userId: string, companyId: string, expiresAt: Date): Promise<string> {
    const jti = crypto.randomUUID();
    await this.repo().insert({
      id: crypto.randomUUID(),
      jti,
      userId,
      companyId,
      expiresAt,
      revokedAt: null,
    });
    return jti;
  }

  async isLive(jti: string): Promise<boolean> {
    const row = await this.repo().findOne({ where: { jti, revokedAt: IsNull() } });
    if (!row) return false;
    return row.expiresAt > new Date();
  }

  async revoke(jti: string): Promise<void> {
    await this.repo().update({ jti, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  async revokeAllFor(userId: string): Promise<void> {
    await this.repo().update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }
}
