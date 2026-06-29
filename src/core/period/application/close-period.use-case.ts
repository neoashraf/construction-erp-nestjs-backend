/**
 * ClosePeriodUseCase (FR-PER-008). OPEN→CLOSED, stamps closedAt/closedBy, audit-logged — atomic.
 * Requires `period.close` (enforced by the RBAC guard in presentation once auth-jwt lands). A non-OPEN
 * period is rejected (PeriodAlreadyClosedError); a concurrent close/reopen → OPTIMISTIC_LOCK_CONFLICT
 * (version guard in the repo save).
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { Actor } from '../../tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../audit/application/audit.port';
import { AccountingPeriod } from '../domain/accounting-period';
import {
  ACCOUNTING_PERIOD_REPOSITORY,
  AccountingPeriodRepository,
} from '../domain/ports/accounting-period.repository';

@Injectable()
export class ClosePeriodUseCase {
  constructor(
    @Inject(ACCOUNTING_PERIOD_REPOSITORY) private readonly periods: AccountingPeriodRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(id: string, actor: Actor): Promise<AccountingPeriod> {
    return this.uow.run(async () => {
      const period = await this.periods.findById(id, actor.companyId);
      if (!period) throw new NotFoundError(`Accounting period ${id} not found`);
      period.close(actor.userId, this.clock);
      await this.periods.save(period);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'AccountingPeriod',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
        after: { status: 'CLOSED', event: 'PERIOD_CLOSE' },
      });
      return period;
    });
  }
}
