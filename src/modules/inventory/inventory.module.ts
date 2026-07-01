/**
 * Inventory module (INV) — composition root (brief 2: Stock Journal voucher — lifecycle + posting).
 * Extends brief 1's partial module: keeps the existing STOCK_MOVEMENT_REPOSITORY binding and the
 * read-only StockLedgerController/StockLedgerQueryService wiring intact, and adds:
 *   - PostingModule import (LED PostingService — the ONLY ledger writer, FR-INV-016);
 *   - CostControlModule import (TAG_CONSISTENCY_SERVICE — FR-CC-004 side consistency);
 *   - AuthModule import (AccessPolicy — approver project-scope, FR-INV-013);
 *   - the new StockJournalRepository port→adapter binding;
 *   - the new InventoryAccountResolver port→adapter binding (MAS seam);
 *   - the four Stock Journal use cases + the DRAFT-only update/delete use cases;
 *   - the new StockJournalController + StockJournalQueryService.
 * AUDIT_SERVICE + UNIT_OF_WORK + CLOCK + ID_GENERATOR are provided globally.
 */
import { Module } from '@nestjs/common';
import { PostingModule } from '../../core/posting/posting.module';
import { AuthModule } from '../../core/auth/auth.module';
import { CostControlModule } from '../../core/cost-control/cost-control.module';
import { STOCK_MOVEMENT_REPOSITORY } from './domain/ports/stock-movement.repository';
import { STOCK_JOURNAL_REPOSITORY } from './domain/ports/stock-journal.repository';
import { INVENTORY_ACCOUNT_RESOLVER } from './domain/ports/inventory-account-resolver.port';
import { TypeOrmStockMovementRepository } from './infrastructure/typeorm-stock-movement.repository';
import { TypeOrmStockJournalRepository } from './infrastructure/typeorm-stock-journal.repository';
import { InventoryAccountResolverAdapter } from './infrastructure/inventory-account-resolver.adapter';
import { StockLedgerQueryService } from './application/stock-ledger-query.service';
import { StockJournalQueryService } from './application/stock-journal-query.service';
import { CreateStockJournalUseCase } from './application/create-stock-journal.usecase';
import {
  DeleteStockJournalUseCase,
  UpdateStockJournalUseCase,
} from './application/update-stock-journal.usecase';
import { ApproveStockJournalUseCase } from './application/approve-stock-journal.usecase';
import { PostStockJournalUseCase } from './application/post-stock-journal.usecase';
import { ReverseStockJournalUseCase } from './application/reverse-stock-journal.usecase';
import { StockLedgerController } from './presentation/stock-ledger.controller';
import { StockJournalController } from './presentation/stock-journal.controller';

@Module({
  imports: [PostingModule, AuthModule, CostControlModule],
  controllers: [StockLedgerController, StockJournalController],
  providers: [
    // ports → adapters
    { provide: STOCK_MOVEMENT_REPOSITORY, useClass: TypeOrmStockMovementRepository },
    { provide: STOCK_JOURNAL_REPOSITORY, useClass: TypeOrmStockJournalRepository },
    { provide: INVENTORY_ACCOUNT_RESOLVER, useClass: InventoryAccountResolverAdapter },
    // use cases
    CreateStockJournalUseCase,
    UpdateStockJournalUseCase,
    DeleteStockJournalUseCase,
    ApproveStockJournalUseCase,
    PostStockJournalUseCase,
    ReverseStockJournalUseCase,
    // read
    StockLedgerQueryService,
    StockJournalQueryService,
  ],
  exports: [STOCK_MOVEMENT_REPOSITORY],
})
export class InventoryModule {}
