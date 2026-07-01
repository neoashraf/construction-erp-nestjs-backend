/**
 * CreateContraUseCase — save a contra DRAFT (no number, no ledger impact — FR-GEN-014). Resolves the
 * account classification snapshot (MAS) then builds the pure aggregate, which enforces the bank/cash
 * restriction (FR-GEN-003). Runs inside the caller's UoW; audits inside the transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { ContraVoucher, NewContra } from '../domain/contra-voucher';
import {
  ACCOUNT_CLASSIFICATION,
  AccountClassification,
  AccountClassificationSnapshot,
} from '../domain/ports/account-classification.port';
import {
  CONTRA_VOUCHER_REPOSITORY,
  ContraVoucherRepository,
} from '../domain/ports/contra-voucher.repository';

@Injectable()
export class CreateContraUseCase {
  constructor(
    @Inject(CONTRA_VOUCHER_REPOSITORY) private readonly repo: ContraVoucherRepository,
    @Inject(ACCOUNT_CLASSIFICATION) private readonly classify: AccountClassification,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: NewContra, actor: Actor): Promise<{ id: string }> {
    return this.uow.run(async () => {
      const snapshot = await AccountClassificationSnapshot.load(
        this.classify,
        actor.companyId,
        (input.lines ?? []).map((l) => l.accountId),
      );
      const voucher = ContraVoucher.createDraft(
        this.ids.next(),
        actor.companyId,
        actor.financialYearId,
        input,
        snapshot,
      );
      await this.repo.insert(voucher);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'ContraVoucher',
        entityId: voucher.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id: voucher.id };
    });
  }
}
