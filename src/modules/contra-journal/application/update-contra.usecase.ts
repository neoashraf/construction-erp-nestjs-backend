/**
 * UpdateContraUseCase / DeleteContraUseCase — edit or soft-delete a contra DRAFT ONLY (FR-GEN-014); a
 * posted/cancelled voucher is immutable (NotDraftError → VOUCHER_POSTED_IMMUTABLE). Optimistic-locked by
 * `version`. Runs inside the caller's UoW.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { assertVersion } from '../../master-data/application/optimistic-lock';
import { NewContra, NewContraLine } from '../domain/contra-voucher';
import { NotDraftError } from '../domain/errors';

/** A PATCH replaces supplied fields; an omitted field keeps the draft's current value (API contract). */
export interface ContraPatch {
  voucherDate?: string;
  narration?: string | null;
  lines?: NewContraLine[];
}
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
export class UpdateContraUseCase {
  constructor(
    @Inject(CONTRA_VOUCHER_REPOSITORY) private readonly repo: ContraVoucherRepository,
    @Inject(ACCOUNT_CLASSIFICATION) private readonly classify: AccountClassification,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, patch: ContraPatch, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const voucher = await this.repo.findById(id, actor.companyId);
      if (!voucher) throw new NotFoundError(`Contra voucher ${id} not found`);
      assertVersion(voucher.version, version, 'ContraVoucher', id);

      // A PATCH replaces supplied fields; omitted fields keep the draft's current value.
      const currentLines: NewContraLine[] = voucher.props.lines.map((l) => ({
        accountId: l.props.accountId,
        debit: l.props.debit,
        credit: l.props.credit,
        narration: l.props.narration,
      }));
      const input: NewContra = {
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
        entityType: 'ContraVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}

@Injectable()
export class DeleteContraUseCase {
  constructor(
    @Inject(CONTRA_VOUCHER_REPOSITORY) private readonly repo: ContraVoucherRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async execute(id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const voucher = await this.repo.findById(id, actor.companyId);
      if (!voucher) throw new NotFoundError(`Contra voucher ${id} not found`);
      if (voucher.props.status !== 'DRAFT') throw new NotDraftError(voucher.props.status);
      await this.repo.softDelete(id, actor.companyId);
      await this.audit.record({
        action: 'DELETE',
        entityType: 'ContraVoucher',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
