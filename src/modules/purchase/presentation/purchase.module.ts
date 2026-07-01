/**
 * PurchaseModule (PUR) — composition root. Binds the PUR ports -> adapters and wires the Purchase Bill +
 * Purchase Order controllers. Imports PostingModule (LED `PostingService` — the ONLY ledger writer),
 * InventoryModule (INV — exports `INVENTORY_SERVICE`/`INVENTORY_ACCOUNT_RESOLVER`, this brief's
 * `receiveIn`/`reverseReceipt` + per-item inventory account resolution seam), CostControlModule (CC —
 * `TagConsistencyService`/`BudgetCheckService`), and AuthModule (JwtAuthGuard/RolesGuard/AccessPolicy —
 * mandatory, this is a BRAND-NEW controller bootstrapping RBAC from scratch, skill §9/§13).
 *
 * SEAMS: `PURCHASE_INVENTORY_SERVICE` / the `InventoryAccountResolver` PUR's own `PurchaseAccountMapAdapter`
 * constructor-injects are bound to the SAME `InventoryServiceAdapter` / `InventoryAccountResolverAdapter`
 * classes INV's own module provides (its own DI tokens are internal to INV — PUR never imports them
 * directly, only the classes, per the one-owner-per-entity rule; mirrors REQ's `requisition.module.ts`
 * exactly). `PurchaseAccountMapPort`/`PurchaseConfigPort` are bound to adapters that read MAS `account`
 * rows directly (MAS exports no account-map service to PUR yet — rebind when it does, same seam style as
 * SAL's `SalesAccountMapAdapter`/`IpcConfigAdapter`). AUDIT_SERVICE + UNIT_OF_WORK + CLOCK + ID_GENERATOR
 * are provided globally.
 */
import { Module } from '@nestjs/common';
import { PostingModule } from '../../../core/posting/posting.module';
import { AuthModule } from '../../../core/auth/auth.module';
import { CostControlModule } from '../../../core/cost-control/cost-control.module';
import { InventoryModule } from '../../inventory/inventory.module';
import { InventoryServiceAdapter } from '../../inventory/application/inventory.service';
import { CreatePurchaseOrderUseCase } from '../application/create-purchase-order.usecase';
import { ApprovePurchaseOrderUseCase } from '../application/approve-purchase-order.usecase';
import {
  CancelPurchaseOrderUseCase,
  UpdatePurchaseOrderDraftUseCase,
} from '../application/update-purchase-order-draft.usecase';
import { CreatePurchaseBillUseCase } from '../application/create-purchase-bill.usecase';
import {
  DeletePurchaseBillUseCase,
  UpdatePurchaseBillDraftUseCase,
} from '../application/update-purchase-bill-draft.usecase';
import { PostPurchaseBillUseCase } from '../application/post-purchase-bill.usecase';
import { CancelPurchaseBillUseCase } from '../application/cancel-purchase-bill.usecase';
import { RepostPurchaseBillUseCase } from '../application/repost-purchase-bill.usecase';
import { PurchaseQueryService } from '../application/purchase-query.service';
import { PURCHASE_ORDER_REPOSITORY } from '../domain/ports/purchase-order.repository';
import { PURCHASE_BILL_REPOSITORY } from '../domain/ports/purchase-bill.repository';
import { PURCHASE_ACCOUNT_MAP_PORT } from '../domain/ports/purchase-account-map.port';
import { PURCHASE_CONFIG_PORT } from '../domain/ports/purchase-config.port';
import { PURCHASE_PROJECT_STATUS_PORT } from '../domain/ports/purchase-project-status.port';
import { PURCHASE_INVENTORY_SERVICE } from '../domain/ports/inventory.service.port';
import { TypeOrmPurchaseOrderRepository } from '../infrastructure/typeorm-purchase-order.repository';
import { TypeOrmPurchaseBillRepository } from '../infrastructure/typeorm-purchase-bill.repository';
import { PurchaseAccountMapAdapter } from '../infrastructure/purchase-account-map.adapter';
import { PurchaseConfigAdapter } from '../infrastructure/purchase-config.adapter';
import { PurchaseProjectStatusAdapter } from '../infrastructure/purchase-project-status.adapter';
import { PurchaseController, PurchaseOrdersController } from './purchase.controller';

@Module({
  imports: [PostingModule, InventoryModule, CostControlModule, AuthModule],
  controllers: [PurchaseController, PurchaseOrdersController],
  providers: [
    // ports -> adapters
    { provide: PURCHASE_ORDER_REPOSITORY, useClass: TypeOrmPurchaseOrderRepository },
    { provide: PURCHASE_BILL_REPOSITORY, useClass: TypeOrmPurchaseBillRepository },
    { provide: PURCHASE_ACCOUNT_MAP_PORT, useClass: PurchaseAccountMapAdapter },
    { provide: PURCHASE_CONFIG_PORT, useClass: PurchaseConfigAdapter },
    { provide: PURCHASE_PROJECT_STATUS_PORT, useClass: PurchaseProjectStatusAdapter },
    // PUR's own DI token bound to INV's SAME adapter class (no parallel implementation) — mirrors REQ.
    // `INVENTORY_ACCOUNT_RESOLVER` needs no re-binding here: InventoryModule exports it, and
    // PurchaseAccountMapAdapter injects it by INV's own token directly (decision 2 — a thin delegate, not
    // a re-implementation), so importing InventoryModule above already makes it resolvable.
    { provide: PURCHASE_INVENTORY_SERVICE, useClass: InventoryServiceAdapter },
    // use cases
    CreatePurchaseOrderUseCase,
    UpdatePurchaseOrderDraftUseCase,
    ApprovePurchaseOrderUseCase,
    CancelPurchaseOrderUseCase,
    CreatePurchaseBillUseCase,
    UpdatePurchaseBillDraftUseCase,
    DeletePurchaseBillUseCase,
    PostPurchaseBillUseCase,
    CancelPurchaseBillUseCase,
    RepostPurchaseBillUseCase,
    // read
    PurchaseQueryService,
  ],
})
export class PurchaseModule {}
