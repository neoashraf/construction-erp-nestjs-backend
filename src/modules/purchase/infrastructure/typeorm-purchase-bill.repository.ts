/**
 * TypeOrmPurchaseBillRepository (INFRASTRUCTURE) — persists the PurchaseBill aggregate (header + lines).
 * Enrols in the active UnitOfWork via getManager. Every method is companyId-scoped (F3).
 * `findByIdForUpdate` takes a pessimistic row lock inside the post/cancel/repost UoW (anti-double-post,
 * AC11). `save` bumps `version` under the optimistic-lock check.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { PurchaseBill } from '../domain/purchase-bill';
import { PurchaseBillRepository } from '../domain/ports/purchase-bill.repository';
import { PurchaseBillMapper } from './purchase-bill.mapper';
import { PurchaseBillLineOrmEntity } from './purchase-bill-line.orm-entity';
import { PurchaseBillOrmEntity } from './purchase-bill.orm-entity';

@Injectable()
export class TypeOrmPurchaseBillRepository implements PurchaseBillRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(bill: PurchaseBill): Promise<void> {
    const m = getManager(this.dataSource);
    const header = PurchaseBillMapper.toOrm(bill);
    header.version = 1;
    await m.getRepository(PurchaseBillOrmEntity).insert(header);
    const lines = bill.lines.map((l) => PurchaseBillMapper.lineToOrm(bill.id, l));
    if (lines.length) await m.getRepository(PurchaseBillLineOrmEntity).insert(lines);
  }

  async save(bill: PurchaseBill, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const header = PurchaseBillMapper.toOrm(bill);
    const res = await m
      .getRepository(PurchaseBillOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        projectId: header.projectId,
        supplierId: header.supplierId,
        purchaseOrderId: header.purchaseOrderId,
        supplierInvoiceRef: header.supplierInvoiceRef,
        billDate: header.billDate,
        dueDate: header.dueDate,
        grossAmount: header.grossAmount,
        vatInputAmount: header.vatInputAmount,
        tdsAmount: header.tdsAmount,
        aitAmount: header.aitAmount,
        netPayableAmount: header.netPayableAmount,
        narration: header.narration,
        status: header.status,
        entryNo: header.entryNo,
        journalEntryId: header.journalEntryId,
        postedAt: header.postedAt,
        postedBy: header.postedBy,
        version: expectedVersion + 1,
      })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: header.id,
        companyId: header.companyId,
        version: expectedVersion,
      })
      .execute();
    if (!res.affected) {
      throw new OptimisticLockConflictError(`Purchase Bill ${header.id} was modified concurrently`, {
        id: header.id,
      });
    }

    // Line upsert (only meaningful for DRAFT edits — a POSTED bill's lines are never patched again, but
    // the save path is shared, mirroring SAL/REQ's line-upsert style).
    const lineRepo = m.getRepository(PurchaseBillLineOrmEntity);
    const existingLineIds = new Set(
      (await lineRepo.find({ where: { purchaseBillId: bill.id }, select: { id: true } })).map((l) => l.id),
    );
    const currentLines = bill.lines.map((l) => PurchaseBillMapper.lineToOrm(bill.id, l));
    const currentLineIds = new Set(currentLines.map((l) => l.id));
    const toInsert = currentLines.filter((l) => !existingLineIds.has(l.id));
    const toUpdate = currentLines.filter((l) => existingLineIds.has(l.id));
    const toDeleteIds = [...existingLineIds].filter((id) => !currentLineIds.has(id));
    if (toInsert.length) await lineRepo.insert(toInsert);
    for (const l of toUpdate) {
      await lineRepo.update({ id: l.id } as never, {
        lineNo: l.lineNo,
        itemId: l.itemId,
        expenseAccountId: l.expenseAccountId,
        isStockLine: l.isStockLine,
        billedQty: l.billedQty,
        rate: l.rate,
        lineAmount: l.lineAmount,
        vatInputAmount: l.vatInputAmount,
        tdsAmount: l.tdsAmount,
        aitAmount: l.aitAmount,
        godownId: l.godownId,
        projectId: l.projectId,
        costCentreId: l.costCentreId,
        purposeId: l.purposeId,
        receivedQty: l.receivedQty,
      });
    }
    if (toDeleteIds.length) await lineRepo.delete(toDeleteIds);
  }

  async findById(id: string, companyId: string): Promise<PurchaseBill | null> {
    return this.load(id, companyId, false);
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<PurchaseBill | null> {
    return this.load(id, companyId, true);
  }

  private async load(id: string, companyId: string, lock: boolean): Promise<PurchaseBill | null> {
    const m = getManager(this.dataSource);
    const qb = m
      .getRepository(PurchaseBillOrmEntity)
      .createQueryBuilder('b')
      .where('b.id = :id AND b.company_id = :companyId AND b.deleted_at IS NULL', { id, companyId });
    if (lock) qb.setLock('pessimistic_write');
    const header = await qb.getOne();
    if (!header) return null;
    const lines = await m.getRepository(PurchaseBillLineOrmEntity).find({ where: { purchaseBillId: id } });
    return PurchaseBillMapper.toDomain(header, lines);
  }

  async softDelete(id: string, companyId: string): Promise<void> {
    await getManager(this.dataSource)
      .getRepository(PurchaseBillOrmEntity)
      .update({ id, companyId } as never, { deletedAt: new Date() });
  }
}
