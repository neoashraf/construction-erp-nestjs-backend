/**
 * UpdateCompanyUseCase (FR-MAS-001, FR-MAS-004, FR-MAS-032). Patches company identity fields under
 * optimistic concurrency. Scoped to the actor's own company (single-company Phase 1): a request for a
 * different company id is a 404, never a cross-tenant edit. UPDATE audit with before/after.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import {
  COMPANY_REPOSITORY,
  CompanyRepository,
} from '../../company/domain/ports/company.repository';
import { AUDIT_SERVICE, AuditService } from '../ports/audit.port';
import { assertVersion } from '../optimistic-lock';
import { companySnapshot } from './company.snapshot';

export interface UpdateCompanyInput {
  name?: string;
  legalName?: string;
  bin?: string;
  tin?: string;
  address?: string | null;
}

@Injectable()
export class UpdateCompanyUseCase {
  constructor(
    @Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(
    id: string,
    input: UpdateCompanyInput,
    expectedVersion: number,
    actor: Actor,
  ): Promise<void> {
    await this.uow.run(async () => {
      const company = await this.companies.findById(id);
      if (!company || company.id !== actor.companyId) {
        throw new NotFoundError(`Company ${id} not found`);
      }
      assertVersion(company.version, expectedVersion, 'Company', id);
      const before = companySnapshot(company);
      company.updateIdentity(input);
      await this.companies.save(company);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'Company',
        entityId: company.id,
        actorId: actor.userId,
        companyId: company.id,
        before,
        after: companySnapshot(company),
      });
    });
  }
}
