/**
 * Inventory module (INV) — composition root. Brief 1 shipped the read-only stock-ledger core; brief 2
 * added the Stock Journal voucher (lifecycle + posting); brief 3 (this addition) publishes the
 * `InventoryService` port PUR/REQ inject into their own modules:
 *   - PostingModule import (LED PostingService — the ONLY ledger writer, FR-INV-016);
 *   - CostControlModule import (TAG_CONSISTENCY_SERVICE — FR-CC-004 side consistency);
 *   - AuthModule import (AccessPolicy — approver project-scope, FR-INV-013);
 *   - the StockJournalRepository / InventoryAccountResolver port→adapter bindings (brief 2);
 *   - the Stock Journal use cases + the DRAFT-only update/delete use cases (brief 2);
 *   - the StockJournalController + StockJournalQueryService (brief 2);
 *   - the new INVENTORY_SERVICE port→adapter binding (brief 3) — exported so PUR/REQ can inject it; adds
 *     NO new route (the port is in-process only, FR-INV-006).
 * AUDIT_SERVICE + UNIT_OF_WORK + CLOCK + ID_GENERATOR are provided globally.
 */
import { Module } from '@nestjs/common';
import { PostingModule } from '../../core/posting/posting.module';
import { AuthModule } from '../../core/auth/auth.module';
import { CostControlModule } from '../../core/cost-control/cost-control.module';
import { STOCK_MOVEMENT_REPOSITORY } from './domain/ports/stock-movement.repository';
import { STOCK_JOURNAL_REPOSITORY } from './domain/ports/stock-journal.repository';
import { INVENTORY_ACCOUNT_RESOLVER } from './domain/ports/inventory-account-resolver.port';
import { INVENTORY_SERVICE } from './domain/ports/inventory.service.port';
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
import { InventoryServiceAdapter } from './application/inventory.service';
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
    { provide: INVENTORY_SERVICE, useClass: InventoryServiceAdapter },
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
  exports: [STOCK_MOVEMENT_REPOSITORY, INVENTORY_SERVICE, INVENTORY_ACCOUNT_RESOLVER],
})
export class InventoryModule {}
