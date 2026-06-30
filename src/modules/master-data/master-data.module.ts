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
// Posting-dimension masters (master-data-dimensions)
import { TypeOrmCostCentreRepository } from './cost-centre/infrastructure/typeorm-cost-centre.repository';
import { CreateCostCentreUseCase, RenameCostCentreUseCase, DeactivateCostCentreUseCase, ReactivateCostCentreUseCase, SeedStandardCostCentresUseCase } from './cost-centre/application/cost-centre.use-cases';
import { CostCentreQueryService } from './cost-centre/read/cost-centre.query-service';
import { CostCentreController } from './cost-centre/presentation/cost-centre.controller';
import { TypeOrmProjectRepository } from './project/infrastructure/typeorm-project.repository';
import { CreateProjectUseCase, UpdateProjectUseCase, ChangeProjectStatusUseCase } from './project/application/project.use-cases';
import { ProjectQueryService } from './project/read/project.query-service';
import { ProjectController } from './project/presentation/project.controller';
import { TypeOrmProjectBudgetRepository } from './project-budget/infrastructure/typeorm-project-budget.repository';
import { UpsertProjectBudgetUseCase, DeleteProjectBudgetUseCase } from './project-budget/application/project-budget.use-cases';
import { ProjectBudgetQueryService } from './project-budget/read/project-budget.query-service';
import { ProjectBudgetController } from './project-budget/presentation/project-budget.controller';
import { TypeOrmPurposeRepository } from './purpose/infrastructure/typeorm-purpose.repository';
import { InlineCreatePurposeUseCase, RenamePurposeUseCase, SetPurposeActiveUseCase } from './purpose/application/purpose.use-cases';
import { PurposeQueryService } from './purpose/read/purpose.query-service';
import { PurposeController } from './purpose/presentation/purpose.controller';
import { TypeOrmGodownRepository } from './godown/infrastructure/typeorm-godown.repository';
import { CreateGodownUseCase, UpdateGodownUseCase, SetGodownActiveUseCase } from './godown/application/godown.use-cases';
import { GodownQueryService } from './godown/read/godown.query-service';
import { GodownController } from './godown/presentation/godown.controller';

@Module({
  controllers: [
    CompanyController,
    FinancialYearController,
    CostCentreController,
    ProjectController,
    ProjectBudgetController,
    PurposeController,
    GodownController,
  ],
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
    // dimensions: repositories
    TypeOrmCostCentreRepository,
    TypeOrmProjectRepository,
    TypeOrmProjectBudgetRepository,
    TypeOrmPurposeRepository,
    TypeOrmGodownRepository,
    // dimensions: use cases
    CreateCostCentreUseCase,
    RenameCostCentreUseCase,
    DeactivateCostCentreUseCase,
    ReactivateCostCentreUseCase,
    SeedStandardCostCentresUseCase,
    CreateProjectUseCase,
    UpdateProjectUseCase,
    ChangeProjectStatusUseCase,
    UpsertProjectBudgetUseCase,
    DeleteProjectBudgetUseCase,
    InlineCreatePurposeUseCase,
    RenamePurposeUseCase,
    SetPurposeActiveUseCase,
    CreateGodownUseCase,
    UpdateGodownUseCase,
    SetGodownActiveUseCase,
    // dimensions: read services
    CostCentreQueryService,
    ProjectQueryService,
    ProjectBudgetQueryService,
    PurposeQueryService,
    GodownQueryService,
  ],
})
export class MasterDataModule {}
