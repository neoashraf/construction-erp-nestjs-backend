/**
 * MasterDataModule — composition root for the MAS organisation masters (Company + FinancialYear).
 * Binds domain ports → infrastructure adapters (ports & adapters, ADR-0002 §2.1). Other masters
 * (projects, cost centres, accounts, parties, items, …) are added by their own briefs.
 *
 * SEAMS (until their owning briefs land):
 *   - AUDIT_SERVICE → NoopAuditService (real AuditService owned by AUD / `rbac-and-audit`).
 *   - Auth guards (JwtAuthGuard + RolesGuard) owned by AUD / `auth-jwt`; actor resolved via
 *     `@CurrentActor` for now.
 */
import { Module } from '@nestjs/common';
import { COMPANY_REPOSITORY } from './company/domain/ports/company.repository';
import { TypeOrmCompanyRepository } from './company/infrastructure/persistence/typeorm-company.repository';
import { FINANCIAL_YEAR_REPOSITORY } from './financial-year/domain/ports/financial-year.repository';
import { TypeOrmFinancialYearRepository } from './financial-year/infrastructure/persistence/typeorm-financial-year.repository';
import { AUDIT_SERVICE } from './application/ports/audit.port';
import { NoopAuditService } from './infrastructure/noop-audit.service';
import { CreateCompanyUseCase } from './application/company/create-company.use-case';
import { UpdateCompanyUseCase } from './application/company/update-company.use-case';
import { UpdateLocalizationUseCase } from './application/company/update-localization.use-case';
import { CreateFinancialYearUseCase } from './application/financial-year/create-financial-year.use-case';
import { UpdateFinancialYearUseCase } from './application/financial-year/update-financial-year.use-case';
import { SetActiveFinancialYearUseCase } from './application/financial-year/set-active-financial-year.use-case';
import { CompanyQueryService } from './company/read/company.query-service';
import { FinancialYearQueryService } from './financial-year/read/financial-year.query-service';
import { CompanyController } from './company/presentation/company.controller';
import { FinancialYearController } from './financial-year/presentation/financial-year.controller';

@Module({
  controllers: [CompanyController, FinancialYearController],
  providers: [
    { provide: COMPANY_REPOSITORY, useClass: TypeOrmCompanyRepository },
    { provide: FINANCIAL_YEAR_REPOSITORY, useClass: TypeOrmFinancialYearRepository },
    { provide: AUDIT_SERVICE, useClass: NoopAuditService },
    CreateCompanyUseCase,
    UpdateCompanyUseCase,
    UpdateLocalizationUseCase,
    CreateFinancialYearUseCase,
    UpdateFinancialYearUseCase,
    SetActiveFinancialYearUseCase,
    CompanyQueryService,
    FinancialYearQueryService,
  ],
})
export class MasterDataModule {}
