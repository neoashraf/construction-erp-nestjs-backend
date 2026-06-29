/**
 * UpdateNumberingSeriesUseCase (FR-NUM-018/020/022). Forward-only edit of prefix/paddingWidth under
 * optimistic concurrency; `companyId`/`financialYearId`/`voucherType`/`lastSequence` are immutable (not
 * accepted). Affects subsequent allocations only; never renumbers prior numbers. UPDATE audit.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../audit/application/audit.port';
import { normalizePaddingWidth, normalizePrefix } from '../domain/numbering-series';
import {
  NUMBERING_SERIES_ADMIN_REPOSITORY,
  NumberingSeriesAdminRepository,
} from '../domain/ports/numbering-series.repository';

export interface UpdateNumberingSeriesInput {
  prefix?: string;
  paddingWidth?: number;
  version: number;
}

@Injectable()
export class UpdateNumberingSeriesUseCase {
  constructor(
    @Inject(NUMBERING_SERIES_ADMIN_REPOSITORY)
    private readonly repo: NumberingSeriesAdminRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, input: UpdateNumberingSeriesInput, actor: Actor): Promise<void> {
    const prefix = input.prefix !== undefined ? normalizePrefix(input.prefix) : undefined;
    const paddingWidth =
      input.paddingWidth !== undefined ? normalizePaddingWidth(input.paddingWidth) : undefined;

    await this.uow.run(async () => {
      const existing = await this.repo.findById(id, actor.companyId);
      if (!existing) throw new NotFoundError(`Numbering series ${id} not found`);
      if (existing.version !== input.version) {
        throw new OptimisticLockConflictError(undefined, { id, expectedVersion: input.version });
      }
      const ok = await this.repo.updateConfig(id, actor.companyId, input.version, {
        prefix,
        paddingWidth,
      });
      if (!ok) throw new OptimisticLockConflictError(undefined, { id });
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'NumberingSeries',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: { prefix: existing.prefix, paddingWidth: existing.paddingWidth },
        after: { prefix: prefix ?? existing.prefix, paddingWidth: paddingWidth ?? existing.paddingWidth },
      });
    });
  }
}
