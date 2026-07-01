/**
 * TypeOrmPurchaseOrderRepository (INFRASTRUCTURE) — persists the PurchaseOrder aggregate (header + lines).
 * Enrols in the active UnitOfWork via getManager. Every method is companyId-scoped (F3).
 * `findByIdForUpdate` row-locks the PO inside a mutating UoW (approve, or the bill-post's applyBilledQty
 * update — anti-concurrent-approve/bill). `openLines` exposes the open (unbilled) lines for bill/GRN
 * defaulting (FR-PUR-003). Lines are upserted by id — never delete-then-reinsert, since a bill line stores
 * its own dims and never FKs to a PO line (no cross-line-id integrity concern here, but the pattern mirrors
 * REQ's line-upsert style regardless, for consistency).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { PurchaseOrder, PurchaseOrderLineProps } from '../domain/purchase-order';
import { PurchaseOrderRepository } from '../domain/ports/purchase-order.repository';
import { PurchaseOrderMapper } from './purchase-order.mapper';
import { PurchaseOrderLineOrmEntity } from './purchase-order-line.orm-entity';
import { PurchaseOrderOrmEntity } from './purchase-order.orm-entity';

@Injectable()
export class TypeOrmPurchaseOrderRepository implements PurchaseOrderRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(po: PurchaseOrder): Promise<void> {
    const m = getManager(this.dataSource);
    const header = PurchaseOrderMapper.toOrm(po);
    header.version = 1;
    await m.getRepository(PurchaseOrderOrmEntity).insert(header);
    const lines = po.lines.map((l) => PurchaseOrderMapper.lineToOrm(po.id, l));
    if (lines.length) await m.getRepository(PurchaseOrderLineOrmEntity).insert(lines);
  }

  async save(po: PurchaseOrder, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const header = PurchaseOrderMapper.toOrm(po);
    const res = await m
      .getRepository(PurchaseOrderOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        projectId: header.projectId,
        supplierId: header.supplierId,
        poRefNo: header.poRefNo,
        poDate: header.poDate,
        expectedDeliveryDate: header.expectedDeliveryDate,
        status: header.status,
        narration: header.narration,
        approvedBy: header.approvedBy,
        approvedAt: header.approvedAt,
        version: expectedVersion + 1,
      })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: header.id,
        companyId: header.companyId,
        version: expectedVersion,
      })
      .execute();
    if (!res.affected) {
      throw new OptimisticLockConflictError(`Purchase Order ${header.id} was modified concurrently`, {
        id: header.id,
      });
    }

    const lineRepo = m.getRepository(PurchaseOrderLineOrmEntity);
    const existingLineIds = new Set(
      (await lineRepo.find({ where: { purchaseOrderId: po.id }, select: { id: true } })).map((l) => l.id),
    );
    const currentLines = po.lines.map((l) => PurchaseOrderMapper.lineToOrm(po.id, l));
    const currentLineIds = new Set(currentLines.map((l) => l.id));
    const toInsert = currentLines.filter((l) => !existingLineIds.has(l.id));
    const toUpdate = currentLines.filter((l) => existingLineIds.has(l.id));
    const toDeleteIds = [...existingLineIds].filter((id) => !currentLineIds.has(id));
    if (toInsert.length) await lineRepo.insert(toInsert);
    for (const l of toUpdate) {
      await lineRepo.update({ id: l.id } as never, {
        lineNo: l.lineNo,
        itemId: l.itemId,
        orderedQty: l.orderedQty,
        rate: l.rate,
        lineAmount: l.lineAmount,
        godownId: l.godownId,
        projectId: l.projectId,
        costCentreId: l.costCentreId,
        purposeId: l.purposeId,
        billedQty: l.billedQty,
        receivedQty: l.receivedQty,
      });
    }
    if (toDeleteIds.length) await lineRepo.delete(toDeleteIds);
  }

  async findById(id: string, companyId: string): Promise<PurchaseOrder | null> {
    return this.load(id, companyId, false);
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<PurchaseOrder | null> {
    return this.load(id, companyId, true);
  }

  private async load(id: string, companyId: string, lock: boolean): Promise<PurchaseOrder | null> {
    const m = getManager(this.dataSource);
    const qb = m
      .getRepository(PurchaseOrderOrmEntity)
      .createQueryBuilder('po')
      .where('po.id = :id AND po.company_id = :companyId', { id, companyId });
    if (lock) qb.setLock('pessimistic_write');
    const header = await qb.getOne();
    if (!header) return null;
    const lines = await m.getRepository(PurchaseOrderLineOrmEntity).find({ where: { purchaseOrderId: id } });
    return PurchaseOrderMapper.toDomain(header, lines);
  }

  async openLines(poId: string, companyId: string): Promise<PurchaseOrderLineProps[]> {
    const po = await this.findById(poId, companyId);
    if (!po) return [];
    return po.lines.filter((l) => l.billedQty.lessThan(l.orderedQty));
  }
}
