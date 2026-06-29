/**
 * GeneratePeriodsUseCase (FR-PER-002/003/004). Creates one OPEN period per month spanning the FY
 * `[startDate, endDate]` (MAS) — contiguous, inclusive, non-overlapping. Rejects an unknown FY
 * (FinancialYearNotFoundError) and a pre-existing set (PeriodsAlreadyExistError). Atomic.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { DateOnly } from '../../../common/value-objects/date-only';
import { Actor } from '../../tenancy/tenant-context';
import { AccountingPeriod } from '../domain/accounting-period';
import { FinancialYearNotFoundError, PeriodsAlreadyExistError } from '../domain/errors';
import { monthlyPeriods } from '../domain/period-generation';
import {
  ACCOUNTING_PERIOD_REPOSITORY,
  AccountingPeriodRepository,
} from '../domain/ports/accounting-period.repository';

@Injectable()
export class GeneratePeriodsUseCase {
  constructor(
    @Inject(ACCOUNTING_PERIOD_REPOSITORY) private readonly periods: AccountingPeriodRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(financialYearId: string, actor: Actor): Promise<AccountingPeriod[]> {
    return this.uow.run(async () => {
      const bounds = await this.periods.financialYearBounds(actor.companyId, financialYearId);
      if (!bounds) throw new FinancialYearNotFoundError(financialYearId);
      if (await this.periods.existsAnyForFy(actor.companyId, financialYearId)) {
        throw new PeriodsAlreadyExistError(financialYearId);
      }
      const spans = monthlyPeriods(bounds.startDate, bounds.endDate);
      const created = spans.map((s) =>
        AccountingPeriod.create(this.ids.next(), {
          companyId: actor.companyId,
          financialYearId,
          name: s.name,
          startDate: DateOnly.of(s.startDate),
          endDate: DateOnly.of(s.endDate),
        }),
      );
      await this.periods.saveMany(created);
      return created;
    });
  }
}
