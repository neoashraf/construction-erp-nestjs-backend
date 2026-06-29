/**
 * Period kernel module (PER) — composition root. Binds the PeriodService guard port (consumed by LED's
 * PostingService) → PeriodServiceImpl, and AccountingPeriodRepository → the TypeORM adapter. Exports
 * PERIOD_SERVICE so PostingModule can inject it. AUDIT_SERVICE is global (AuditModule).
 */
import { Module } from '@nestjs/common';
import { PERIOD_SERVICE } from '../posting/domain/ports/period.service';
import { PeriodServiceImpl } from './application/period.service';
import { ACCOUNTING_PERIOD_REPOSITORY } from './domain/ports/accounting-period.repository';
import { TypeOrmAccountingPeriodRepository } from './infrastructure/typeorm-accounting-period.repository';
import { GeneratePeriodsUseCase } from './application/generate-periods.use-case';
import { ClosePeriodUseCase } from './application/close-period.use-case';
import { ReopenPeriodUseCase } from './application/reopen-period.use-case';
import { CloseFyUseCase } from './application/close-fy.use-case';
import { PeriodQueryService } from './read/period-query.service';
import { PeriodController } from './presentation/period.controller';

@Module({
  controllers: [PeriodController],
  providers: [
    { provide: ACCOUNTING_PERIOD_REPOSITORY, useClass: TypeOrmAccountingPeriodRepository },
    { provide: PERIOD_SERVICE, useClass: PeriodServiceImpl },
    GeneratePeriodsUseCase,
    ClosePeriodUseCase,
    ReopenPeriodUseCase,
    CloseFyUseCase,
    PeriodQueryService,
  ],
  exports: [PERIOD_SERVICE],
})
export class PeriodModule {}
