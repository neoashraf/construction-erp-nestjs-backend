/**
 * Core kernel composition (ADR-0002 §2.1). Bundles the shared-kernel modules every feature module
 * depends on. `core/*` imports nothing from `modules/*`. All are empty-but-wired in the scaffold.
 */
import { Module } from '@nestjs/common';
import { PostingModule } from './posting/posting.module';
import { NumberingModule } from './numbering/numbering.module';
import { PeriodModule } from './period/period.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { CostControlModule } from './cost-control/cost-control.module';

@Module({
  imports: [
    PostingModule,
    NumberingModule,
    PeriodModule,
    AuditModule,
    AuthModule,
    TenancyModule,
    CostControlModule,
  ],
  exports: [
    PostingModule,
    NumberingModule,
    PeriodModule,
    AuditModule,
    AuthModule,
    TenancyModule,
    CostControlModule,
  ],
})
export class CoreModule {}
