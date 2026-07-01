/**
 * RequisitionModule (REQ) — composition root. Binds the REQ ports → adapters and wires the requisition
 * workflow controller. Imports AuthModule (AccessPolicy — project scope + approval authority) and
 * CostControlModule (TagConsistencyService + BudgetCheckService). AUDIT_SERVICE + UNIT_OF_WORK + CLOCK +
 * ID_GENERATOR are provided globally.
 *
 * SCOPE (brief 1 of 2): this is the requisition WORKFLOW half — create/submit/approve/reject/close. It
 * writes NO ledger entry and moves NO stock. The ISSUE (`…/issue`, consumption post, INV `issueOut`, the
 * stock deduction) is the downstream brief #23 (requisition-issue-posting) — which adds InventoryModule +
 * PostingModule imports and the issue ports here.
 *
 * SEAMS: RequisitionMasterRefPort reads MAS masters directly; IndicativeRateReadPort reads INV's
 * `stock_movement` (INV exports no rate service to REQ yet — rebind when it does); ApprovalThresholdPort
 * returns a config default (pending client — overview §10); NotificationPort logs the trigger (AUD owns
 * delivery — rebind when AUD exposes a notification service).
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../../../core/auth/auth.module';
import { CostControlModule } from '../../../core/cost-control/cost-control.module';
import { CreateRequisitionUseCase } from '../application/create-requisition.usecase';
import { SubmitRequisitionUseCase } from '../application/submit-requisition.usecase';
import { ApproveRequisitionUseCase } from '../application/approve-requisition.usecase';
import { RejectRequisitionUseCase } from '../application/reject-requisition.usecase';
import { CloseRequisitionUseCase } from '../application/close-requisition.usecase';
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
import { TypeOrmRequisitionRepository } from '../infrastructure/typeorm-requisition.repository';
import { RequisitionMasterRefAdapter } from '../infrastructure/requisition-master-ref.adapter';
import { IndicativeRateAdapter } from '../infrastructure/indicative-rate.adapter';
import { ApprovalThresholdAdapter } from '../infrastructure/approval-threshold.adapter';
import { LoggingNotificationAdapter } from '../infrastructure/logging-notification.adapter';
import { RequisitionController } from './requisition.controller';

@Module({
  imports: [AuthModule, CostControlModule],
  controllers: [RequisitionController],
  providers: [
    // ports → adapters
    { provide: REQUISITION_REPOSITORY, useClass: TypeOrmRequisitionRepository },
    { provide: REQUISITION_MASTER_REF_PORT, useClass: RequisitionMasterRefAdapter },
    { provide: INDICATIVE_RATE_READ_PORT, useClass: IndicativeRateAdapter },
    { provide: APPROVAL_THRESHOLD_READ_PORT, useClass: ApprovalThresholdAdapter },
    { provide: NOTIFICATION_PORT, useClass: LoggingNotificationAdapter },
    // use cases
    CreateRequisitionUseCase,
    UpdateRequisitionDraftUseCase,
    DeleteRequisitionUseCase,
    SubmitRequisitionUseCase,
    ApproveRequisitionUseCase,
    RejectRequisitionUseCase,
    CloseRequisitionUseCase,
    // read
    RequisitionQueryService,
  ],
})
export class RequisitionModule {}
