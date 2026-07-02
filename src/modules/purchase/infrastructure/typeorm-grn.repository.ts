/**
 * TypeOrmGrnRepository (INFRASTRUCTURE) — persists the Grn aggregate (header + lines). Enrols in the
 * active UnitOfWork via getManager. Every method is companyId-scoped (F3). `findByIdForUpdate` takes a
 * pessimistic row lock inside the post/cancel UoW (anti-double-post). `receivedSoFar` sums received_qty
 * across POSTED GRN lines per purchase_bill_line — CANCELLED GRNs drop out (FR-PUR-017/-018).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Grn } from '../domain/grn';
import { GrnRepository } from '../domain/ports/grn.repository';
import { GrnMapper } from './grn.mapper';
import { GrnLineOrmEntity } from './grn-line.orm-entity';
import { GrnOrmEntity } from './grn.orm-entity';

@Injectable()
export class TypeOrmGrnRepository implements GrnRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(grn: Grn): Promise<void> {
    const m = getManager(this.dataSource);
    const header = GrnMapper.toOrm(grn);
    header.version = 1;
    await m.getRepository(GrnOrmEntity).insert(header);
    const lines = grn.lines.map((l) => GrnMapper.lineToOrm(grn.id, l));
    if (lines.length) await m.getRepository(GrnLineOrmEntity).insert(lines);
  }

  async save(grn: Grn, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const header = GrnMapper.toOrm(grn);
    const res = await m
      .getRepository(GrnOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        projectId: header.projectId,
        supplierId: header.supplierId,
        purchaseOrderId: header.purchaseOrderId,
        purchaseBillId: header.purchaseBillId,
        grnRefNo: header.grnRefNo,
        receiptDate: header.receiptDate,
        status: header.status,
        receivedBy: header.receivedBy,
        narration: header.narration,
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
      throw new OptimisticLockConflictError(`GRN ${header.id} was modified concurrently`, { id: header.id });
    }

    // Line upsert (mirrors TypeOrmPurchaseBillRepository's shared save path).
    const lineRepo = m.getRepository(GrnLineOrmEntity);
    const existingLineIds = new Set(
      (await lineRepo.find({ where: { grnId: grn.id }, select: { id: true } })).map((l) => l.id),
    );
    const currentLines = grn.lines.map((l) => GrnMapper.lineToOrm(grn.id, l));
    const currentLineIds = new Set(currentLines.map((l) => l.id));
    const toInsert = currentLines.filter((l) => !existingLineIds.has(l.id));
    const toUpdate = currentLines.filter((l) => existingLineIds.has(l.id));
    const toDeleteIds = [...existingLineIds].filter((id) => !currentLineIds.has(id));
    if (toInsert.length) await lineRepo.insert(toInsert);
    for (const l of toUpdate) {
      await lineRepo.update({ id: l.id } as never, {
        lineNo: l.lineNo,
        purchaseBillLineId: l.purchaseBillLineId,
        itemId: l.itemId,
        receivedQty: l.receivedQty,
        rate: l.rate,
        receivedValue: l.receivedValue,
        godownId: l.godownId,
        projectId: l.projectId,
        costCentreId: l.costCentreId,
        purposeId: l.purposeId,
        matchStatus: l.matchStatus,
      });
    }
    if (toDeleteIds.length) await lineRepo.delete(toDeleteIds);
  }

  async findById(id: string, companyId: string): Promise<Grn | null> {
    return this.load(id, companyId, false);
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<Grn | null> {
    return this.load(id, companyId, true);
  }

  async receivedSoFar(purchaseBillLineId: string, companyId: string): Promise<Decimal> {
    const m = getManager(this.dataSource);
    const [row] = (await m.query(
      `SELECT COALESCE(SUM(gl.received_qty), 0)::text AS total
         FROM grn_line gl
         JOIN grn g ON g.id = gl.grn_id
        WHERE gl.purchase_bill_line_id = $1 AND g.company_id = $2 AND g.status = 'POSTED'`,
      [purchaseBillLineId, companyId],
    )) as { total: string }[];
    return new Decimal(row?.total ?? 0);
  }

  private async load(id: string, companyId: string, lock: boolean): Promise<Grn | null> {
    const m = getManager(this.dataSource);
    const qb = m
      .getRepository(GrnOrmEntity)
      .createQueryBuilder('g')
      .where('g.id = :id AND g.company_id = :companyId', { id, companyId });
    if (lock) qb.setLock('pessimistic_write');
    const header = await qb.getOne();
    if (!header) return null;
    const lines = await m.getRepository(GrnLineOrmEntity).find({ where: { grnId: id } });
    return GrnMapper.toDomain(header, lines);
  }
}
