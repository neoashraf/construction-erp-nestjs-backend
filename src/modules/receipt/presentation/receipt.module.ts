/**
 * ReceiptModule (REC) — composition root. Binds the REC ports -> adapters and wires the Receipt
 * controller. Imports PostingModule (the single ledger writer, exported by core) and AuthModule (for
 * JwtAuthGuard/RolesGuard + their Role/Permission repository deps, per the mandatory RBAC-guard rule).
 * REC posts every receipt command through PostingService inside its own UnitOfWork; it never writes
 * journal_entry/journal_line directly (CLAUDE.md 1-2; FR-REC-009).
 *
 * SEAM: `IpcReferencePort` is bound to `IpcReferenceAdapter`, which reads SAL's `IpcOrmEntity` directly
 * (SalesModule exports no repository — the same cross-module ORM-entity read pattern
 * MasAccountClassificationAdapter uses for MAS's AccountOrmEntity). `ReceiptAccountMapPort` reads MAS
 * `account` rows by well-known CoA code. AUDIT_SERVICE + UNIT_OF_WORK + CLOCK + ID_GENERATOR are provided
 * globally.
 */
import { Module } from '@nestjs/common';
import { PostingModule } from '../../../core/posting/posting.module';
import { AuthModule } from '../../../core/auth/auth.module';
import { CreateReceiptUseCase } from '../application/create-receipt.usecase';
import { DeleteReceiptUseCase, UpdateReceiptDraftUseCase } from '../application/update-receipt-draft.usecase';
import { PostReceiptUseCase } from '../application/post-receipt.usecase';
import { CancelReceiptUseCase } from '../application/cancel-receipt.usecase';
import { RepostReceiptUseCase } from '../application/repost-receipt.usecase';
import { ReceiptQueryService } from '../application/receipt-query.service';
import { RECEIPT_REPOSITORY } from '../domain/ports/receipt.repository';
import { RECEIPT_ACCOUNT_MAP_PORT } from '../domain/ports/receipt-account-map.port';
import { IPC_REFERENCE_PORT } from '../domain/ports/ipc-reference.port';
import { TypeOrmReceiptRepository } from '../infrastructure/typeorm-receipt.repository';
import { ReceiptAccountMapAdapter } from '../infrastructure/receipt-account-map.adapter';
import { IpcReferenceAdapter } from '../infrastructure/ipc-reference.adapter';
import { ReceiptController } from './receipt.controller';

@Module({
  imports: [PostingModule, AuthModule],
  controllers: [ReceiptController],
  providers: [
    // ports -> adapters
    { provide: RECEIPT_REPOSITORY, useClass: TypeOrmReceiptRepository },
    { provide: RECEIPT_ACCOUNT_MAP_PORT, useClass: ReceiptAccountMapAdapter },
    { provide: IPC_REFERENCE_PORT, useClass: IpcReferenceAdapter },
    // use cases
    CreateReceiptUseCase,
    UpdateReceiptDraftUseCase,
    DeleteReceiptUseCase,
    PostReceiptUseCase,
    CancelReceiptUseCase,
    RepostReceiptUseCase,
    // read
    ReceiptQueryService,
  ],
})
export class ReceiptModule {}
