/**
 * ContraJournalModule (GEN) — composition root. Binds the GEN ports → adapters and wires the two
 * voucher controllers. Imports PostingModule (the single ledger writer, exported by core). GEN posts
 * every contra/journal/opening command through PostingService inside the shared UnitOfWork; it never
 * writes journal_entry/journal_line directly (CLAUDE.md 1–2; FR-GEN-015).
 *
 * SEAMS: the MAS ports (AccountClassification, OpeningBalanceReader, ControlAccountResolver) are bound
 * to adapters that read MAS `account`/`party` directly (MAS exports no repositories); when MAS exports
 * an account-classification/opening service, rebind here. AUDIT_SERVICE + UNIT_OF_WORK + CLOCK +
 * ID_GENERATOR are provided globally (AuditModule / InfrastructureModule).
 */
import { Module } from '@nestjs/common';
import { PostingModule } from '../../../core/posting/posting.module';
import { AuthModule } from '../../../core/auth/auth.module';
import { CreateContraUseCase } from '../application/create-contra.usecase';
import { DeleteContraUseCase, UpdateContraUseCase } from '../application/update-contra.usecase';
import { PostContraUseCase } from '../application/post-contra.usecase';
import { CreateJournalUseCase } from '../application/create-journal.usecase';
import { DeleteJournalUseCase, UpdateJournalUseCase } from '../application/update-journal.usecase';
import { PostJournalUseCase } from '../application/post-journal.usecase';
import { PostOpeningJournalUseCase } from '../application/post-opening-journal.usecase';
import { OpeningJournalAssembler } from '../application/opening-journal.assembler';
import { ReverseContraUseCase, ReverseJournalUseCase } from '../application/reverse-voucher.usecase';
import { CONTRA_VOUCHER_REPOSITORY } from '../domain/ports/contra-voucher.repository';
import { JOURNAL_VOUCHER_REPOSITORY } from '../domain/ports/journal-voucher.repository';
import { ACCOUNT_CLASSIFICATION } from '../domain/ports/account-classification.port';
import {
  CONTROL_ACCOUNT_RESOLVER,
  OPENING_BALANCE_READER,
} from '../domain/ports/opening-balance.port';
import { TypeOrmContraVoucherRepository } from '../infrastructure/typeorm-contra-voucher.repository';
import { TypeOrmJournalVoucherRepository } from '../infrastructure/typeorm-journal-voucher.repository';
import { MasAccountClassificationAdapter } from '../infrastructure/mas-account-classification.adapter';
import { MasOpeningBalanceAdapter } from '../infrastructure/mas-opening-balance.adapter';
import { ContraController } from './contra.controller';
import { JournalController } from './journal.controller';
import { ContraJournalQueryService } from './contra-journal.query-service';

@Module({
  imports: [PostingModule, AuthModule],
  controllers: [ContraController, JournalController],
  providers: [
    // ports → adapters
    { provide: CONTRA_VOUCHER_REPOSITORY, useClass: TypeOrmContraVoucherRepository },
    { provide: JOURNAL_VOUCHER_REPOSITORY, useClass: TypeOrmJournalVoucherRepository },
    { provide: ACCOUNT_CLASSIFICATION, useClass: MasAccountClassificationAdapter },
    { provide: OPENING_BALANCE_READER, useClass: MasOpeningBalanceAdapter },
    { provide: CONTROL_ACCOUNT_RESOLVER, useClass: MasOpeningBalanceAdapter },
    // use cases
    CreateContraUseCase,
    UpdateContraUseCase,
    DeleteContraUseCase,
    PostContraUseCase,
    ReverseContraUseCase,
    CreateJournalUseCase,
    UpdateJournalUseCase,
    DeleteJournalUseCase,
    PostJournalUseCase,
    ReverseJournalUseCase,
    OpeningJournalAssembler,
    PostOpeningJournalUseCase,
    // read
    ContraJournalQueryService,
  ],
})
export class ContraJournalModule {}
