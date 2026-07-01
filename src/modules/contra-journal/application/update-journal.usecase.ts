/**
 * UpdateJournalUseCase / DeleteJournalUseCase — edit or soft-delete a journal DRAFT ONLY (FR-GEN-014);
 * posted/cancelled is immutable. The opening journal is assembled, not hand-edited (a PATCH on it is
 * still gated by DRAFT-only + version). Optimistic-locked; runs inside the caller's UoW.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { assertVersion } from '../../master-data/application/optimistic-lock';
import { NewJournal, NewJournalLine } from '../domain/journal-voucher';
import { NotDraftError } from '../domain/errors';

/** A PATCH replaces supplied fields; an omitted field keeps the draft's current value (API contract). */
export interface JournalPatch {
  voucherDate?: string;
  narration?: string | null;
  lines?: NewJournalLine[];
}
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
export class UpdateJournalUseCase {
  constructor(
    @Inject(JOURNAL_VOUCHER_REPOSITORY) private readonly repo: JournalVoucherRepository,
    @Inject(ACCOUNT_CLASSIFICATION) private readonly classify: AccountClassification,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, patch: JournalPatch, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const voucher = await this.repo.findById(id, actor.companyId);
      if (!voucher) throw new NotFoundError(`Journal voucher ${id} not found`);
      assertVersion(voucher.version, version, 'JournalVoucher', id);

      const currentLines: NewJournalLine[] = voucher.props.lines.map((l) => ({
        accountId: l.props.accountId,
        projectId: l.props.projectId,
        costCentreId: l.props.costCentreId,
        purposeId: l.props.purposeId,
        partyId: l.props.partyId,
        debit: l.props.debit,
        credit: l.props.credit,
        narration: l.props.narration,
      }));
      const input: NewJournal = {
        voucherType: voucher.props.voucherType,
        voucherDate: patch.voucherDate ?? voucher.props.voucherDate,
        narration: patch.narration !== undefined ? patch.narration : voucher.props.narration,
        lines: patch.lines ?? currentLines,
      };
      const snapshot = await AccountClassificationSnapshot.load(
        this.classify,
        actor.companyId,
        input.lines.map((l) => l.accountId),
      );
      voucher.updateDraft(input, snapshot);
      await this.repo.save(voucher, version);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'JournalVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}

@Injectable()
export class DeleteJournalUseCase {
  constructor(
    @Inject(JOURNAL_VOUCHER_REPOSITORY) private readonly repo: JournalVoucherRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const voucher = await this.repo.findById(id, actor.companyId);
      if (!voucher) throw new NotFoundError(`Journal voucher ${id} not found`);
      if (voucher.props.status !== 'DRAFT') throw new NotDraftError(voucher.props.status);
      await this.repo.softDelete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE',
        entityType: 'JournalVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
