/**
 * Shared persistence helpers for the lean-CRUD MAS masters (skill §2.3). A version-guarded UPDATE
 * (optimistic concurrency, FR-MAS-032) and a unique-violation detector — so each master repository
 * stays a few lines. INFRASTRUCTURE.
 */
import { EntityTarget, ObjectLiteral, Repository, QueryFailedError } from 'typeorm';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';

const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { driverError?: { code?: string } }).driverError?.code ===
      PG_UNIQUE_VIOLATION
  );
}

/** Version-guarded, company-scoped UPDATE; bumps version + updated_at. Throws 409 on a stale write. */
export async function versionedUpdate<T extends ObjectLiteral>(
  repo: Repository<T>,
  target: EntityTarget<T>,
  id: string,
  companyId: string,
  expectedVersion: number,
  set: Record<string, unknown>,
): Promise<void> {
  const qb = repo.createQueryBuilder().update(target);
  const payload = { ...set, updatedAt: () => 'now()', version: () => '"version" + 1' };
  const result = await qb
    .set(payload as unknown as Parameters<typeof qb.set>[0])
    .where('id = :id AND company_id = :companyId AND version = :version', {
      id,
      companyId,
      version: expectedVersion,
    })
    .execute();
  if (!result.affected) {
    throw new OptimisticLockConflictError(undefined, { id, expectedVersion });
  }
}
