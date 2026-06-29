/**
 * SetActiveFinancialYearUseCase (FR-MAS-003). Marks exactly one financial year active per company:
 * clears the currently-active FY then activates the target, atomically in one `uow.run`. The clear
 * happens BEFORE the set so the `(company_id) WHERE is_active` partial-unique index is never
 * transiently violated within the transaction; the index is the DB backstop. Switching the active FY
 * alters no posted data (edge §12.7). ACTIVATE audit on the new year.
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
import { financialYearSnapshot } from './financial-year.snapshot';

@Injectable()
export class SetActiveFinancialYearUseCase {
  constructor(
    @Inject(FINANCIAL_YEAR_REPOSITORY) private readonly years: FinancialYearRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const target = await this.years.findById(id, actor.companyId);
      if (!target) throw new NotFoundError(`Financial year ${id} not found`);
      if (target.isActive) return; // already the active year — no-op

      const current = await this.years.findActive(actor.companyId);
      if (current) {
        current.deactivate();
        await this.years.save(current, actor.companyId); // clear FIRST (one-active invariant)
      }

      target.activate();
      await this.years.save(target, actor.companyId);

      await this.audit.record({
        action: 'ACTIVATE',
        entityType: 'FinancialYear',
        entityId: target.id,
        actorId: actor.userId,
        companyId: actor.companyId,
        before: current ? { previousActiveId: current.id } : null,
        after: financialYearSnapshot(target),
      });
    });
  }
}
