/**
 * CreateFinancialYearUseCase (FR-MAS-002). Creates a financial year for the actor's company —
 * inactive on creation; overlapping years are allowed (no overlap rejection). The `end_date >
 * start_date` rule is enforced in the entity. Atomic create + CREATE audit (FR-MAS-031).
 */
import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { FinancialYear } from '../../financial-year/domain/financial-year';
import {
  FINANCIAL_YEAR_REPOSITORY,
  FinancialYearRepository,
} from '../../financial-year/domain/ports/financial-year.repository';
import { AUDIT_SERVICE, AuditService } from '../ports/audit.port';
import { financialYearSnapshot } from './financial-year.snapshot';

export interface CreateFinancialYearInput {
  label: string;
  startDate: string;
  endDate: string;
}

@Injectable()
export class CreateFinancialYearUseCase {
  constructor(
    @Inject(FINANCIAL_YEAR_REPOSITORY) private readonly years: FinancialYearRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateFinancialYearInput, actor: Actor): Promise<{ id: string }> {
    const fy = FinancialYear.create({ companyId: actor.companyId, ...input }, this.ids);
    await this.uow.run(async () => {
      await this.years.save(fy, actor.companyId);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'FinancialYear',
        entityId: fy.id,
        actorId: actor.userId,
        companyId: actor.companyId,
        after: financialYearSnapshot(fy),
      });
    });
    return { id: fy.id };
  }
}
