/**
 * UpdateFinancialYearUseCase (FR-MAS-002, FR-MAS-032). Edits label / start / end under optimistic
 * concurrency, scoped to the actor's company. The `end_date > start_date` rule is re-checked in the
 * entity when a bound moves. UPDATE audit with before/after.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import {
  FINANCIAL_YEAR_REPOSITORY,
  FinancialYearRepository,
} from '../../financial-year/domain/ports/financial-year.repository';
import { AUDIT_SERVICE, AuditService } from '../ports/audit.port';
import { assertVersion } from '../optimistic-lock';
import { financialYearSnapshot } from './financial-year.snapshot';

export interface UpdateFinancialYearInput {
  label?: string;
  startDate?: string;
  endDate?: string;
}

@Injectable()
export class UpdateFinancialYearUseCase {
  constructor(
    @Inject(FINANCIAL_YEAR_REPOSITORY) private readonly years: FinancialYearRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(
    id: string,
    input: UpdateFinancialYearInput,
    expectedVersion: number,
    actor: Actor,
  ): Promise<void> {
    await this.uow.run(async () => {
      const fy = await this.years.findById(id, actor.companyId);
      if (!fy) throw new NotFoundError(`Financial year ${id} not found`);
      assertVersion(fy.version, expectedVersion, 'FinancialYear', id);
      const before = financialYearSnapshot(fy);
      fy.update(input);
      await this.years.save(fy, actor.companyId);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'FinancialYear',
        entityId: fy.id,
        actorId: actor.userId,
        companyId: actor.companyId,
        before,
        after: financialYearSnapshot(fy),
      });
    });
  }
}
