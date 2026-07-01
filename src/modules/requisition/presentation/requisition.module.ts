/**
 * RequisitionModule (REQ) — composition root. Binds the REQ ports → adapters and wires the requisition
 * workflow + issue controller. Imports AuthModule (AccessPolicy — project scope + approval authority),
 * CostControlModule (TagConsistencyService + BudgetCheckService), InventoryModule (brief #23 —
 * INVENTORY_SERVICE / INVENTORY_ACCOUNT_RESOLVER, the issue's stock-deduct + account-resolution seam), and
 * PostingModule (LED PostingService — the ONLY ledger writer). AUDIT_SERVICE + UNIT_OF_WORK + CLOCK +
 * ID_GENERATOR are provided globally.
 *
 * SCOPE: brief 1 shipped the requisition WORKFLOW half (create/submit/approve/reject/close — no ledger, no
 * stock). Brief #23 (requisition-issue-posting, this addition) adds the ISSUE half: `…/issue`,
 * `…/issues/:issueId/reverse`, `GET /:id/issues` — REQ_INVENTORY_SERVICE / REQ_INVENTORY_ACCOUNT_RESOLVER
 * are bound to the SAME `InventoryServiceAdapter` / `InventoryAccountResolverAdapter` classes INV's own
 * module provides (its own DI tokens, `INVENTORY_SERVICE`/`INVENTORY_ACCOUNT_RESOLVER`, are internal to
 * INV — REQ never imports them directly, only the classes, per the one-owner-per-entity rule).
 *
 * SEAMS: RequisitionMasterRefPort reads MAS masters directly; IndicativeRateReadPort reads INV's
 * `stock_movement` (INV exports no rate service to REQ yet — rebind when it does); ApprovalThresholdPort
 * returns a config default (pending client — overview §10); NotificationPort logs the trigger (AUD owns
 * delivery — rebind when AUD exposes a notification service).
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../../../core/auth/auth.module';
import { CostControlModule } from '../../../core/cost-control/cost-control.module';
import { PostingModule } from '../../../core/posting/posting.module';
import { InventoryModule } from '../../inventory/inventory.module';
import { InventoryServiceAdapter } from '../../inventory/application/inventory.service';
import { InventoryAccountResolverAdapter } from '../../inventory/infrastructure/inventory-account-resolver.adapter';
import { CreateRequisitionUseCase } from '../application/create-requisition.usecase';
import { SubmitRequisitionUseCase } from '../application/submit-requisition.usecase';
import { ApproveRequisitionUseCase } from '../application/approve-requisition.usecase';
import { RejectRequisitionUseCase } from '../application/reject-requisition.usecase';
import { CloseRequisitionUseCase } from '../application/close-requisition.usecase';
import { IssueRequisitionUseCase } from '../application/issue-requisition.usecase';
import { ReverseIssueUseCase } from '../application/reverse-issue.usecase';
import {
  DeleteRequisitionUseCase,
  UpdateRequisitionDraftUseCase,
} from '../application/update-requisition-draft.usecase';
import { RequisitionQueryService } from '../application/requisition-query.service';
import { REQUISITION_REPOSITORY } from '../domain/ports/requisition.repository';
import { REQUISITION_MASTER_REF_PORT } from '../domain/ports/requisition-master-ref.port';
import { INDICATIVE_RATE_READ_PORT } from '../domain/ports/indicative-rate.read.port';
import { APPROVAL_THRESHOLD_READ_PORT } from '../domain/ports/approval-threshold.read.port';
import { NOTIFICATION_PORT } from '../domain/ports/notification.port';
import { REQ_INVENTORY_SERVICE } from '../domain/ports/inventory.service.port';
import { REQ_INVENTORY_ACCOUNT_RESOLVER } from '../domain/ports/inventory-account-resolver.port';
import { TypeOrmRequisitionRepository } from '../infrastructure/typeorm-requisition.repository';
import { RequisitionMasterRefAdapter } from '../infrastructure/requisition-master-ref.adapter';
import { IndicativeRateAdapter } from '../infrastructure/indicative-rate.adapter';
import { ApprovalThresholdAdapter } from '../infrastructure/approval-threshold.adapter';
import { LoggingNotificationAdapter } from '../infrastructure/logging-notification.adapter';
import { RequisitionController } from './requisition.controller';

@Module({
  imports: [AuthModule, CostControlModule, InventoryModule, PostingModule],
  controllers: [RequisitionController],
  providers: [
    // ports → adapters
    { provide: REQUISITION_REPOSITORY, useClass: TypeOrmRequisitionRepository },
    { provide: REQUISITION_MASTER_REF_PORT, useClass: RequisitionMasterRefAdapter },
    { provide: INDICATIVE_RATE_READ_PORT, useClass: IndicativeRateAdapter },
    { provide: APPROVAL_THRESHOLD_READ_PORT, useClass: ApprovalThresholdAdapter },
    { provide: NOTIFICATION_PORT, useClass: LoggingNotificationAdapter },
    // brief #23 — REQ's own DI tokens bound to INV's SAME adapter classes (no parallel implementation).
    { provide: REQ_INVENTORY_SERVICE, useClass: InventoryServiceAdapter },
    { provide: REQ_INVENTORY_ACCOUNT_RESOLVER, useClass: InventoryAccountResolverAdapter },
    // use cases
    CreateRequisitionUseCase,
    UpdateRequisitionDraftUseCase,
    DeleteRequisitionUseCase,
    SubmitRequisitionUseCase,
    ApproveRequisitionUseCase,
    RejectRequisitionUseCase,
    CloseRequisitionUseCase,
    IssueRequisitionUseCase,
    ReverseIssueUseCase,
    // read
    RequisitionQueryService,
  ],
})
export class RequisitionModule {}
