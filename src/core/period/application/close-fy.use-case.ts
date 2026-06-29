/**
 * CloseFyUseCase (FR-PER-010). Closes EVERY remaining OPEN period of the FY in one transaction, each
 * individually stamped + audit-logged. Already-CLOSED periods are left unchanged. The FY is then
 * "locked" — the derived condition that all its periods are CLOSED (no separate flag). Rejects when no
 * period set has been generated (NoPeriodsForFyError).
 */
import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { Actor } from '../../tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../audit/application/audit.port';
import { AccountingPeriod } from '../domain/accounting-period';
import { NoPeriodsForFyError } from '../domain/errors';
import {
  ACCOUNTING_PERIOD_REPOSITORY,
  AccountingPeriodRepository,
} from '../domain/ports/accounting-period.repository';

export interface CloseFyResult {
  closedCount: number;
  alreadyClosedCount: number;
  periods: AccountingPeriod[];
}

@Injectable()
export class CloseFyUseCase {
  constructor(
    @Inject(ACCOUNTING_PERIOD_REPOSITORY) private readonly periods: AccountingPeriodRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(financialYearId: string, actor: Actor): Promise<CloseFyResult> {
    return this.uow.run(async () => {
      const all = await this.periods.listByFy(actor.companyId, financialYearId);
      if (all.length === 0) throw new NoPeriodsForFyError(financialYearId);

      const toClose = all.filter((p) => p.isOpen());
      for (const period of toClose) {
        period.close(actor.userId, this.clock);
      }
      if (toClose.length > 0) await this.periods.saveMany(toClose);
      for (const period of toClose) {
        await this.audit.record({
          action: 'UPDATE',
          entityType: 'AccountingPeriod',
          entityId: period.id,
          actorId: actor.userId,
          companyId: actor.companyId,
          after: { status: 'CLOSED', event: 'PERIOD_CLOSE' },
        });
      }
      return {
        closedCount: toClose.length,
        alreadyClosedCount: all.length - toClose.length,
        periods: all,
      };
    });
  }
}
