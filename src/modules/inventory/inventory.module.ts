/**
 * Inventory module (INV) — composition root (PARTIAL, brief 1: stock-ledger core). Binds the
 * stock-movement port to its TypeORM adapter and wires the read-only stock-ledger controller/query
 * service. The Stock Journal voucher + post use cases + PostingModule wiring land with brief 2; the
 * InventoryService port (PUR/REQ) with brief 3.
 *
 * Exports STOCK_MOVEMENT_REPOSITORY so the voucher post path (brief 2) and PUR/REQ (brief 3) can append
 * movements + take the locked balance read from inside their own UnitOfWork.
 */
import { Module } from '@nestjs/common';
import { STOCK_MOVEMENT_REPOSITORY } from './domain/ports/stock-movement.repository';
import { TypeOrmStockMovementRepository } from './infrastructure/typeorm-stock-movement.repository';
import { StockLedgerQueryService } from './application/stock-ledger-query.service';
import { StockLedgerController } from './presentation/stock-ledger.controller';

@Module({
  controllers: [StockLedgerController],
  providers: [
    { provide: STOCK_MOVEMENT_REPOSITORY, useClass: TypeOrmStockMovementRepository },
    StockLedgerQueryService,
  ],
  exports: [STOCK_MOVEMENT_REPOSITORY],
})
export class InventoryModule {}
