/**
 * CreateNumberingSeriesUseCase (FR-NUM-001/002/003/022). Admin pre-seeds a series with a prefix +
 * padding; `lastSequence` starts at 0 and is NOT acceptable in the request. Rejects a cross-company
 * financial year (CROSS_COMPANY_REFERENCE) and a duplicate triple (SERIES_ALREADY_EXISTS, raised by
 * the repo on the DB unique violation). Atomic + CREATE audit (FR-NUM-022).
 */
import { Inject, Injectable } from '@nestjs/common';
import { CrossCompanyReferenceError, ValidationError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { Actor } from '../../tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../audit/application/audit.port';
import { isVoucherType } from '../../posting/domain/voucher-type';
import {
  defaultPrefixFor,
  normalizePaddingWidth,
  normalizePrefix,
} from '../domain/numbering-series';
import {
  NUMBERING_SERIES_ADMIN_REPOSITORY,
  NumberingSeriesAdminRepository,
} from '../domain/ports/numbering-series.repository';

export interface CreateNumberingSeriesInput {
  financialYearId: string;
  voucherType: string;
  prefix?: string;
  paddingWidth?: number;
}

@Injectable()
export class CreateNumberingSeriesUseCase {
  constructor(
    @Inject(NUMBERING_SERIES_ADMIN_REPOSITORY)
    private readonly repo: NumberingSeriesAdminRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateNumberingSeriesInput, actor: Actor): Promise<{ id: string }> {
    if (!isVoucherType(input.voucherType)) {
      throw new ValidationError(`Unknown voucherType '${input.voucherType}'`, {
        field: 'voucherType',
      });
    }
    const prefix =
      input.prefix !== undefined ? normalizePrefix(input.prefix) : defaultPrefixFor(input.voucherType);
    const paddingWidth = normalizePaddingWidth(input.paddingWidth);
    const id = this.ids.next();

    await this.uow.run(async () => {
      const belongs = await this.repo.financialYearBelongsToCompany(
        input.financialYearId,
        actor.companyId,
      );
      if (!belongs) {
        throw new CrossCompanyReferenceError(
          'financialYearId does not belong to the actor company',
          { financialYearId: input.financialYearId },
        );
      }
      await this.repo.create({
        id,
        companyId: actor.companyId,
        financialYearId: input.financialYearId,
        voucherType: input.voucherType,
        prefix,
        paddingWidth,
      });
      await this.audit.record({
        action: 'CREATE',
        entityType: 'NumberingSeries',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
        after: { financialYearId: input.financialYearId, voucherType: input.voucherType, prefix, paddingWidth, lastSequence: 0 },
      });
    });
    return { id };
  }
}
