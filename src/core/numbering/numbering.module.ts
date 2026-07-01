/**
 * Numbering kernel module (NUM) — composition root. Binds:
 *   - NUMBERING_SERVICE (the allocator port consumed by PostingService) → TypeOrmNumberingService;
 *   - NUMBERING_SERIES_ADMIN_REPOSITORY → TypeOrmNumberingSeriesRepository.
 * Exports NUMBERING_SERVICE so LED's PostingModule can inject it. `AUDIT_SERVICE` is global (AuditModule).
 * Imports AuthModule for JwtAuthGuard/RolesGuard (+ their ROLE/PERMISSION repository deps) consumed by
 * NumberingAdminController's `@Roles({ module: 'NUM', action })` guards (num-led-cc-rbac-guard-wiring).
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NUMBERING_SERVICE } from '../posting/domain/ports/numbering.service';
import { TypeOrmNumberingService } from './infrastructure/typeorm-numbering.service';
import { NUMBERING_SERIES_ADMIN_REPOSITORY } from './domain/ports/numbering-series.repository';
import { TypeOrmNumberingSeriesRepository } from './infrastructure/typeorm-numbering-series.repository';
import { CreateNumberingSeriesUseCase } from './application/create-numbering-series.use-case';
import { UpdateNumberingSeriesUseCase } from './application/update-numbering-series.use-case';
import { NumberingSeriesReadService } from './read/numbering-series.read-service';
import { NumberingAdminController } from './presentation/numbering-admin.controller';

@Module({
  imports: [AuthModule],
  controllers: [NumberingAdminController],
  providers: [
    { provide: NUMBERING_SERVICE, useClass: TypeOrmNumberingService },
    { provide: NUMBERING_SERIES_ADMIN_REPOSITORY, useClass: TypeOrmNumberingSeriesRepository },
    CreateNumberingSeriesUseCase,
    UpdateNumberingSeriesUseCase,
    NumberingSeriesReadService,
  ],
  exports: [NUMBERING_SERVICE],
})
export class NumberingModule {}
