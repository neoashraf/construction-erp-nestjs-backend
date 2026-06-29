/**
 * CreateCompanyUseCase (FR-MAS-001, FR-MAS-004). Establishes a company (tenant root) with
 * `version=1`, `is_active=true`, and the Phase-1 localization defaults. Atomic create (uow.run —
 * edge §12.9 no partial row) + a CREATE audit record in the same transaction (FR-MAS-031).
 *
 * NOTE: the standard-14 cost-centre seed (FR-MAS-009) is intentionally NOT done here — it belongs to
 * the cost-centre brief. This is the hook the SRS calls out.
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

export type CreateCompanyInput = NewCompany;

@Injectable()
export class CreateCompanyUseCase {
  constructor(
    @Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateCompanyInput, actor: Actor): Promise<{ id: string }> {
    const company = Company.create(input, this.ids);
    await this.uow.run(async () => {
      await this.companies.save(company);
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
