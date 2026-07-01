/**
 * SalesModule (SAL) — composition root. Binds the SAL ports → adapters and wires the IPC controller.
 * Imports PostingModule (the single ledger writer, exported by core) and AuthModule. SAL posts every IPC
 * command through PostingService inside its own UnitOfWork; it never writes journal_entry/journal_line
 * directly (CLAUDE.md 1–2; FR-SAL-009).
 *
 * SEAMS: the MAS ports (SalesAccountMapPort, IpcConfigPort) and the ledger-read AdvanceBalancePort are
 * bound to adapters that read MAS `account`/`project` + the LED `journal_line` directly (MAS/LED export
 * no repositories to SAL). When MAS exports a rate-config / account-map service, rebind here. AUDIT_SERVICE
 * + UNIT_OF_WORK + CLOCK + ID_GENERATOR are provided globally.
 */
import { Module } from '@nestjs/common';
import { PostingModule } from '../../../core/posting/posting.module';
import { AuthModule } from '../../../core/auth/auth.module';
import { CreateIpcUseCase } from '../application/create-ipc.usecase';
import { DeleteIpcUseCase, UpdateIpcDraftUseCase } from '../application/update-ipc-draft.usecase';
import { PostIpcUseCase } from '../application/post-ipc.usecase';
import { CancelIpcUseCase } from '../application/cancel-ipc.usecase';
import { RepostIpcUseCase } from '../application/repost-ipc.usecase';
import { IpcQueryService } from '../application/ipc-query.service';
import { IPC_REPOSITORY } from '../domain/ports/ipc.repository';
import { SALES_ACCOUNT_MAP_PORT } from '../domain/ports/sales-account-map.port';
import { IPC_CONFIG_PORT } from '../domain/ports/ipc-config.port';
import { ADVANCE_BALANCE_PORT } from '../domain/ports/advance-balance.port';
import { TypeOrmIpcRepository } from '../infrastructure/typeorm-ipc.repository';
import { SalesAccountMapAdapter } from '../infrastructure/sales-account-map.adapter';
import { IpcConfigAdapter } from '../infrastructure/ipc-config.adapter';
import { AdvanceBalanceAdapter } from '../infrastructure/advance-balance.adapter';
import { SalesController } from './sales.controller';

@Module({
  imports: [PostingModule, AuthModule],
  controllers: [SalesController],
  providers: [
    // ports → adapters
    { provide: IPC_REPOSITORY, useClass: TypeOrmIpcRepository },
    { provide: SALES_ACCOUNT_MAP_PORT, useClass: SalesAccountMapAdapter },
    { provide: IPC_CONFIG_PORT, useClass: IpcConfigAdapter },
    { provide: ADVANCE_BALANCE_PORT, useClass: AdvanceBalanceAdapter },
    // use cases
    CreateIpcUseCase,
    UpdateIpcDraftUseCase,
    DeleteIpcUseCase,
    PostIpcUseCase,
    CancelIpcUseCase,
    RepostIpcUseCase,
    // read
    IpcQueryService,
  ],
})
export class SalesModule {}
