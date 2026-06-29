/**
 * ReopenPeriodUseCase (FR-PER-009/010). CLOSED→OPEN, clears stamps, audit-logged — atomic. Requires
 * `period.reopen` (Admin-only, enforced in presentation once auth-jwt lands). Rejected when:
 *   - the period is not CLOSED → PeriodAlreadyOpenError (PERIOD_ALREADY_OPEN, 409);
 *   - the FY is YEAR-LOCKED (all its periods CLOSED) → PeriodFyLockedError (PERIOD_FY_LOCKED, 409),
 *     distinct from the permission (403) and wrong-state (409 PERIOD_ALREADY_OPEN) rejections.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../audit/application/audit.port';
import { AccountingPeriod } from '../domain/accounting-period';
import { PeriodFyLockedError } from '../domain/errors';
import {
  ACCOUNTING_PERIOD_REPOSITORY,
  AccountingPeriodRepository,
} from '../domain/ports/accounting-period.repository';

@Injectable()
export class ReopenPeriodUseCase {
  constructor(
    @Inject(ACCOUNTING_PERIOD_REPOSITORY) private readonly periods: AccountingPeriodRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, actor: Actor): Promise<AccountingPeriod> {
    return this.uow.run(async () => {
      const period = await this.periods.findById(id, actor.companyId);
      if (!period) throw new NotFoundError(`Accounting period ${id} not found`);

      // Year-lock: if EVERY period of this FY is CLOSED, the FY is locked — reopen is refused.
      const siblings = await this.periods.listByFy(actor.companyId, period.props.financialYearId);
      if (siblings.length > 0 && siblings.every((p) => !p.isOpen())) {
        throw new PeriodFyLockedError(period.props.financialYearId);
      }

      period.reopen();
      await this.periods.save(period);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'AccountingPeriod',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
        after: { status: 'OPEN', event: 'PERIOD_REOPEN' },
      });
      return period;
    });
  }
}
