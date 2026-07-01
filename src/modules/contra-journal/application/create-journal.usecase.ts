/**
 * CreateJournalUseCase — save a journal DRAFT (no number, no ledger impact — FR-GEN-014). Resolves the
 * account classification (MAS) then builds the pure aggregate, which enforces the conditional tagging
 * (P&L-line dimensions FR-GEN-005; AR/AP control-line party FR-GEN-007). `OPENING` is NOT accepted here
 * (use PostOpeningJournalUseCase). Runs inside the caller's UoW; audits inside the transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { JournalVoucher, NewJournal } from '../domain/journal-voucher';
import {
  ACCOUNT_CLASSIFICATION,
  AccountClassification,
  AccountClassificationSnapshot,
} from '../domain/ports/account-classification.port';
import {
  JOURNAL_VOUCHER_REPOSITORY,
  JournalVoucherRepository,
} from '../domain/ports/journal-voucher.repository';

@Injectable()
export class CreateJournalUseCase {
  constructor(
    @Inject(JOURNAL_VOUCHER_REPOSITORY) private readonly repo: JournalVoucherRepository,
    @Inject(ACCOUNT_CLASSIFICATION) private readonly classify: AccountClassification,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: NewJournal, actor: Actor): Promise<{ id: string }> {
    if (input.voucherType === 'OPENING') {
      throw new ValidationError('The opening journal is assembled via POST /api/journal/opening, not created here');
    }
    return this.uow.run(async () => {
      const snapshot = await AccountClassificationSnapshot.load(
        this.classify,
        actor.companyId,
        (input.lines ?? []).map((l) => l.accountId),
      );
      const voucher = JournalVoucher.createDraft(
        this.ids.next(),
        actor.companyId,
        actor.financialYearId,
        { ...input, voucherType: 'JOURNAL' },
        snapshot,
      );
      await this.repo.insert(voucher);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'JournalVoucher',
        entityId: voucher.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id: voucher.id };
    });
  }
}
