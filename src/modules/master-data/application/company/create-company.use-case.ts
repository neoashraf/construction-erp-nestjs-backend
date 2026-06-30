/**
 * CreateCompanyUseCase (FR-MAS-001, FR-MAS-004). Establishes a company (tenant root) with
 * `version=1`, `is_active=true`, and the Phase-1 localization defaults. Atomic create (uow.run —
 * edge §12.9 no partial row) + a CREATE audit record in the same transaction (FR-MAS-031).
 *
 * On create it also runs the idempotent reference seeds in the same transaction: the standard-14
 * cost centres (FR-MAS-009) and the standard construction chart of accounts (FR-MAS-018/019).
 */
import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { Company, NewCompany } from '../../company/domain/company';
import {
  COMPANY_REPOSITORY,
  CompanyRepository,
} from '../../company/domain/ports/company.repository';
import { AUDIT_SERVICE, AuditService } from '../ports/audit.port';
import { companySnapshot } from './company.snapshot';
import { SeedStandardCostCentresUseCase } from '../../cost-centre/application/cost-centre.use-cases';
import { SeedConstructionCoaUseCase } from '../../chart-of-accounts/application/construction-coa.seed';

export type CreateCompanyInput = NewCompany;

@Injectable()
export class CreateCompanyUseCase {
  constructor(
    @Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly seedCostCentres: SeedStandardCostCentresUseCase,
    private readonly seedCoa: SeedConstructionCoaUseCase,
  ) {}

  async execute(input: CreateCompanyInput, actor: Actor): Promise<{ id: string }> {
    const company = Company.create(input, this.ids);
    await this.uow.run(async () => {
      await this.companies.save(company);
      // FR-MAS-009: seed the standard 14 cost centres for the new company (idempotent).
      await this.seedCostCentres.execute(company.id);
      // FR-MAS-018/019: seed the standard construction chart of accounts (idempotent, design §8).
      await this.seedCoa.execute(company.id);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'Company',
        entityId: company.id,
        actorId: actor.userId,
        companyId: company.id,
        after: companySnapshot(company),
      });
    });
    return { id: company.id };
  }
}
