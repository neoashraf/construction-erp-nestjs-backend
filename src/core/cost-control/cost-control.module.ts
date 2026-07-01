/**
 * CostControlModule (CC) — composition root for the cost-control policy + read layer. Binds the three
 * domain ports to their adapters and exposes the `/api/cost-control` controller. Exports the two
 * internal ports (`BUDGET_CHECK_SERVICE`, `TAG_CONSISTENCY_SERVICE`) so voucher modules (PUR/REQ/PAY/
 * GEN/INV/HR/SAL) can depend on them by interface at their own draft-validation step. CC owns NO
 * migration and NO ledger write — it only reads (DATA_SOURCE is global). `PostingService` never imports
 * or calls CC; the over-budget control is advisory (FR-CC-014).
 * Imports AuthModule for JwtAuthGuard/RolesGuard (+ their ROLE/PERMISSION repository deps) consumed by
 * CostControlController's `@Roles({ module: 'CC', action: 'READ' })` guards (num-led-cc-rbac-guard-wiring).
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CostControlQueryService } from './application/cost-control-query.service';
import { BudgetCheckServiceImpl } from './application/budget-check.service';
import { TagConsistencyServiceImpl } from './application/tag-consistency.service';
import { COST_CONTROL_READ_REPOSITORY } from './domain/ports/cost-control.read.port';
import { BUDGET_CHECK_SERVICE } from './domain/ports/budget-check.service.port';
import { TAG_CONSISTENCY_SERVICE } from './domain/ports/tag-consistency.port';
import { TypeOrmCostControlReadRepository } from './infrastructure/typeorm-cost-control.read.repo';
import { CostControlController } from './presentation/cost-control.controller';

@Module({
  imports: [AuthModule],
  controllers: [CostControlController],
  providers: [
    CostControlQueryService,
    { provide: COST_CONTROL_READ_REPOSITORY, useClass: TypeOrmCostControlReadRepository },
    { provide: BUDGET_CHECK_SERVICE, useClass: BudgetCheckServiceImpl },
    { provide: TAG_CONSISTENCY_SERVICE, useClass: TagConsistencyServiceImpl },
  ],
  exports: [BUDGET_CHECK_SERVICE, TAG_CONSISTENCY_SERVICE],
})
export class CostControlModule {}
