/**
 * PeriodServiceImpl — the post-time guard adapter (application). Implements the `PeriodService` port
 * LED depends on. Resolves (company, FY, date) under a row lock so a concurrent close serialises
 * against the in-flight post (FR-PER-005). Returns for OPEN; throws PeriodClosedError / NoPeriodDefinedError.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PeriodService } from '../../posting/domain/ports/period.service';
import {
  ACCOUNTING_PERIOD_REPOSITORY,
  AccountingPeriodRepository,
} from '../domain/ports/accounting-period.repository';
import { NoPeriodDefinedError, PeriodClosedError } from '../domain/errors';

@Injectable()
export class PeriodServiceImpl implements PeriodService {
  constructor(
    @Inject(ACCOUNTING_PERIOD_REPOSITORY) private readonly periods: AccountingPeriodRepository,
  ) {}

  async assertOpen(companyId: string, financialYearId: string, voucherDate: string): Promise<void> {
    const period = await this.periods.findOwningForUpdate(companyId, financialYearId, voucherDate);
    if (!period) throw new NoPeriodDefinedError(companyId, financialYearId, voucherDate);
    if (!period.isOpen()) throw new PeriodClosedError(period.id, voucherDate);
  }
}
