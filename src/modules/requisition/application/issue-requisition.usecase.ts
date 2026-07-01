/**
 * IssueRequisitionUseCase — issue material against an APPROVED/PARTIALLY_ISSUED requisition (full or
 * partial), stock-deduct + consumption-post, ATOMIC (design §5.2, FR-REQ-012..019). Inside ONE uow.run:
 *   1. row-lock the requisition header (findByIdForUpdate) — anti-double-issue of the whole voucher;
 *   2. assertIssuable() — APPROVED | PARTIALLY_ISSUED else RequisitionNotApprovedError (FR-REQ-012);
 *   3. per requested issue line:
 *      a. row-lock the LINE balance (findLineForUpdate) — anti-over-issue (design §5.4, edge 8);
 *      b. 0 < issueQty ≤ balance else IssueExceedsBalanceError (FR-REQ-012, edge 2);
 *      c. the source godown belongs to the requisition's project else GodownNotInProjectError;
 *      d. inventory.issueOut(...) — INV's own (godown,item) lock + negative-stock guard + valuation
 *         (FR-REQ-013/-016) — REQ computes NO valuation and writes NO stock movement itself;
 *   4. build ONE balanced consumption PostingCommand (Dr expense / Cr inventory per item, four dims) via
 *      buildConsumptionCommand — REQ writes NO journal line itself (FR-REQ-014);
 *   5. posting.post(cmd) — LED: period → project → tags → balance → NUM number, exactly once;
 *   6. record RequisitionIssue(+lines) referencing every movement + the one entry;
 *   7. req.applyIssue(...) — decrement balances, recompute status PARTIALLY_ISSUED/ISSUED (FR-REQ-018/-019);
 *   8. save the requisition + the issue — all inside the ONE uow.run (FR-REQ-015).
 * A forced failure at any step rolls EVERYTHING back — no movement, no entry, no consumed NUM number,
 * balances unchanged (edge 10). Then notify the requester after commit (FR-REQ-023).
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingService } from '../../../core/posting/application/posting.service';
import { RequisitionIssue, NewRequisitionIssueLine } from '../domain/requisition-issue';
import {
  REQUISITION_REPOSITORY,
  RequisitionRepository,
} from '../domain/ports/requisition.repository';
import {
  REQ_INVENTORY_SERVICE,
} from '../domain/ports/inventory.service.port';
import type { InventoryService } from '../domain/ports/inventory.service.port';
import {
  REQ_INVENTORY_ACCOUNT_RESOLVER,
} from '../domain/ports/inventory-account-resolver.port';
import type { InventoryAccountResolver } from '../domain/ports/inventory-account-resolver.port';
import {
  REQUISITION_MASTER_REF_PORT,
  RequisitionMasterRefPort,
} from '../domain/ports/requisition-master-ref.port';
import { NOTIFICATION_PORT, NotificationPort } from '../domain/ports/notification.port';
import { buildConsumptionCommand } from './build-consumption-command';

export interface IssueRequisitionLineInput {
  requisitionLineId: string;
  issueQuantity: string;
  /** Optional per-line godown override; defaults to the request's fromGodownId. */
  godownId?: string;
}

export interface IssueRequisitionInput {
  fromGodownId: string;
  lines: IssueRequisitionLineInput[];
  allowNegativeStock?: boolean;
  negativeStockReason?: string | null;
}

export interface IssueRequisitionResult {
  requisitionIssueId: string;
  issueNo: number;
  journalEntryId: string;
  entryNo: string | null;
  issuedValue: string;
  requisitionStatus: string;
  projectId: string;
}

@Injectable()
export class IssueRequisitionUseCase {
  constructor(
    @Inject(REQUISITION_REPOSITORY) private readonly repo: RequisitionRepository,
    @Inject(REQ_INVENTORY_SERVICE) private readonly inventory: InventoryService,
    @Inject(REQ_INVENTORY_ACCOUNT_RESOLVER) private readonly accounts: InventoryAccountResolver,
    @Inject(REQUISITION_MASTER_REF_PORT) private readonly masters: RequisitionMasterRefPort,
    private readonly posting: PostingService,
    @Inject(NOTIFICATION_PORT) private readonly notify: NotificationPort,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(
    requisitionId: string,
    input: IssueRequisitionInput,
    actor: Actor,
  ): Promise<IssueRequisitionResult> {
    const allowNegativeStock = input.allowNegativeStock ?? false;
    if (allowNegativeStock && !(input.negativeStockReason ?? '').trim()) {
      throw new ValidationError('negativeStockReason is required when allowNegativeStock=true', {});
    }
    if (!input.lines?.length) {
      throw new ValidationError('An issue requires at least one line', { field: 'lines' });
    }

    const result = await this.uow.run(async () => {
      const req = await this.repo.findByIdForUpdate(requisitionId, actor.companyId);
      if (!req) throw new NotFoundError(`Requisition ${requisitionId} not found`);
      req.assertIssuable();
      // Friendly early guard (mirrors HR's HrProjectStatusAdapter precedent) — LED's PostingService ALSO
      // re-checks project status inside posting.post() (FR-REQ-016); this is not the only guard.
      await this.masters.assertProjectNotClosed(actor.companyId, req.props.projectId);

      const now = this.clock.now();
      const voucherDate = now.toISOString().slice(0, 10);

      const issueLines: NewRequisitionIssueLine[] = [];
      const commandLines: { itemId: string; godownId: string; value: Decimal }[] = [];
      const balanceUpdates: { lineId: string; issueQuantity: Decimal }[] = [];

      for (const requested of input.lines) {
        const godownId = requested.godownId ?? input.fromGodownId;
        // GODOWN_NOT_IN_PROJECT / INACTIVE_MASTER_REFERENCE (FR-REQ-012) — MAS is the one owner of this check.
        await this.masters.assertGodownActiveInProject(actor.companyId, godownId, req.props.projectId);

        // Line-balance lock (design §5.4 — the second of the two locks; anti-over-issue).
        const line = await this.repo.findLineForUpdate(requested.requisitionLineId, actor.companyId);
        if (!line || line.requisitionId !== requisitionId) {
          throw new NotFoundError(`Requisition line ${requested.requisitionLineId} not found`);
        }

        const issueQty = new Decimal(requested.issueQuantity);
        const lineIssueId = this.ids.next();

        // INV does the stock deduction: its own (godown,item) lock + negative-stock guard + valuation.
        // REQ computes NO valuation and writes NO stock movement itself (FR-REQ-013).
        const { issuedValue, rate, movementId } = await this.inventory.issueOut(
          { companyId: actor.companyId, voucherDate, postedBy: actor.userId },
          {
            godownId,
            itemId: line.itemId,
            qty: issueQty,
            allowNegative: allowNegativeStock,
            sourceId: lineIssueId,
          },
        );

        issueLines.push({
          id: lineIssueId,
          requisitionLineId: line.id,
          itemId: line.itemId,
          godownId,
          stockMovementId: movementId,
          issuedQuantity: issueQty,
          rate,
          value: issuedValue,
        });
        commandLines.push({ itemId: line.itemId, godownId, value: issuedValue });
        balanceUpdates.push({ lineId: line.id, issueQuantity: issueQty });
      }

      // Build ONE balanced consumption command and post via the ONE posting layer (FR-REQ-014).
      const issueId = this.ids.next();
      const cmd = await buildConsumptionCommand(
        {
          companyId: actor.companyId,
          financialYearId: actor.financialYearId,
          voucherDate,
          projectId: req.props.projectId,
          costCentreId: req.props.costCentreId,
          purposeId: req.props.purposeId,
          postedBy: actor.userId,
          sourceId: issueId,
          lines: commandLines,
        },
        this.accounts,
      );
      const entry = await this.posting.post(cmd);

      const issueNo = await this.repo.nextIssueNo(requisitionId);
      const issue = RequisitionIssue.create(
        issueId,
        requisitionId,
        issueNo,
        input.fromGodownId,
        entry.id,
        entry.props.entryNo,
        issueLines,
        actor.userId,
        now,
        allowNegativeStock ? actor.userId : null,
      );

      req.applyIssue(balanceUpdates);
      await this.repo.saveIssue(issue);
      await this.repo.save(req, req.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'Requisition',
        entityId: requisitionId,
        actorId: actor.userId,
        companyId: actor.companyId,
      });

      return {
        requisitionIssueId: issue.id,
        issueNo,
        journalEntryId: entry.id,
        entryNo: entry.props.entryNo,
        issuedValue: issue.props.issuedValue.toFixed(4),
        requisitionStatus: req.props.status,
        projectId: req.props.projectId,
      };
    });

    await this.notify.notify({
      event: 'REQUISITION_ISSUED',
      requisitionId,
      companyId: actor.companyId,
      projectId: result.projectId,
      recipients: ['REQUESTER'],
    });

    return result;
  }
}
