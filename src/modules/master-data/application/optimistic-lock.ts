/**
 * Optimistic-concurrency guard (FR-MAS-032). Compares the caller's `expectedVersion` against the
 * loaded row's version and throws a typed 409 on mismatch. The DB `@VersionColumn` is the second line
 * of defence against a concurrent write between load and save (skill §2.3 lean tier).
 */
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';

export function assertVersion(current: number, expected: number, entityType: string, id: string): void {
  if (current !== expected) {
    throw new OptimisticLockConflictError(
      `${entityType} ${id} was modified concurrently (expected version ${expected}, found ${current})`,
      { entityType, id, expectedVersion: expected, currentVersion: current },
    );
  }
}
