/**
 * PaymentModule (PAY) — composition root. Binds the PAY ports -> adapters and wires the Payment controller.
 * Imports PostingModule (the single ledger writer, exported by core) and AuthModule (for
 * JwtAuthGuard/RolesGuard + their Role/Permission repository deps, per the mandatory RBAC-guard rule). PAY
 * posts every payment command through PostingService inside its own UnitOfWork; it never writes
 * journal_entry/journal_line directly (CLAUDE.md 1-2).
 *
 * SEAMS: `PayableLookupPort` -> PayableLookupAdapter reads PUR `purchase_bill`, HR `labour_payable`, HR
 * `salary_sheet`/`salary_sheet_line` directly (those modules export no repository — the same cross-module
 * ORM-entity read pattern REC uses for SAL) and computes PAY's own applied-total. `PaymentAccountMapPort`
 * reads MAS `account` rows by well-known CoA code. AUDIT_SERVICE + UNIT_OF_WORK + CLOCK + ID_GENERATOR are
 * provided globally.
 */
import { Module } from '@nestjs/common';
import { PostingModule } from '../../../core/posting/posting.module';
import { AuthModule } from '../../../core/auth/auth.module';
import { CreatePaymentUseCase } from '../application/create-payment.usecase';
import { DeletePaymentUseCase, UpdatePaymentDraftUseCase } from '../application/update-payment-draft.usecase';
import { PostPaymentUseCase } from '../application/post-payment.usecase';
import { CancelPaymentUseCase } from '../application/cancel-payment.usecase';
import { RepostPaymentUseCase } from '../application/repost-payment.usecase';
import { PaymentQueryService } from '../application/payment-query.service';
import { PAYMENT_REPOSITORY } from '../domain/ports/payment.repository';
import { PAYABLE_LOOKUP_PORT } from '../domain/ports/payable-lookup.port';
import { PAYMENT_ACCOUNT_MAP_PORT } from '../domain/ports/payment-account-map.port';
import { PAYABLE_SETTLEMENT_PORT } from '../domain/ports/payable-settlement.port';
import { TypeOrmPaymentRepository } from '../infrastructure/typeorm-payment.repository';
import { PayableLookupAdapter } from '../infrastructure/payable-lookup.adapter';
import { PaymentAccountMapAdapter } from '../infrastructure/payment-account-map.adapter';
import { PaymentAllocationReadModel } from '../infrastructure/payment-allocation.read-model';
import { PayableSettlementAdapter } from '../infrastructure/payable-settlement.adapter';
import { PaymentController } from './payment.controller';

@Module({
  imports: [PostingModule, AuthModule],
  controllers: [PaymentController],
  providers: [
    // ports -> adapters
    { provide: PAYMENT_REPOSITORY, useClass: TypeOrmPaymentRepository },
    { provide: PAYABLE_LOOKUP_PORT, useClass: PayableLookupAdapter },
    { provide: PAYMENT_ACCOUNT_MAP_PORT, useClass: PaymentAccountMapAdapter },
    // read model + exported settlement seam (#28) — PUR/HR read PAY's applied projection through this port.
    PaymentAllocationReadModel,
    { provide: PAYABLE_SETTLEMENT_PORT, useClass: PayableSettlementAdapter },
    // use cases
    CreatePaymentUseCase,
    UpdatePaymentDraftUseCase,
    DeletePaymentUseCase,
    PostPaymentUseCase,
    CancelPaymentUseCase,
    RepostPaymentUseCase,
    // read
    PaymentQueryService,
  ],
  exports: [PAYABLE_SETTLEMENT_PORT, PaymentAllocationReadModel],
})
export class PaymentModule {}
