/**
 * TypeOrmPaymentRepository (INFRASTRUCTURE) — persists the PaymentVoucher aggregate + its allocation rows.
 * Enrols in the active UnitOfWork via getManager. Every method is companyId-scoped. `findByIdForUpdate`
 * takes a pessimistic row lock inside the post UoW (anti-double-post). `save` bumps `version` under the
 * optimistic-lock check, then wholly replaces the voucher's payment_allocation rows with the current
 * (bound) allocations. `delete` hard-deletes a DRAFT voucher (its allocations cascade).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { PaymentVoucher } from '../domain/payment-voucher';
import { PaymentRepository } from '../domain/ports/payment.repository';
import { PaymentMapper } from './payment.mapper';
import { PaymentVoucherOrmEntity } from './payment-voucher.orm-entity';
import { PaymentAllocationOrmEntity } from './payment-allocation.orm-entity';

@Injectable()
export class TypeOrmPaymentRepository implements PaymentRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(payment: PaymentVoucher): Promise<void> {
    const m = getManager(this.dataSource);
    const row = PaymentMapper.toOrm(payment);
    row.version = 1;
    await m.getRepository(PaymentVoucherOrmEntity).insert(row);
    const allocations = PaymentMapper.allocationsToOrm(payment);
    if (allocations.length) await m.getRepository(PaymentAllocationOrmEntity).insert(allocations);
  }

  async save(payment: PaymentVoucher, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const row = PaymentMapper.toOrm(payment);
    const res = await m
      .getRepository(PaymentVoucherOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        partyId: row.partyId,
        paymentDate: row.paymentDate,
        paymentMode: row.paymentMode,
        paymentAccountId: row.paymentAccountId,
        chequeTxnRef: row.chequeTxnRef,
        bankChargesAmount: row.bankChargesAmount,
        bankChargesProjectId: row.bankChargesProjectId,
        bankChargesCostCentreId: row.bankChargesCostCentreId,
        bankChargesPurposeId: row.bankChargesPurposeId,
        paymentAmount: row.paymentAmount,
        narration: row.narration,
        status: row.status,
        entryNo: row.entryNo,
        journalEntryId: row.journalEntryId,
        postedAt: row.postedAt,
        postedBy: row.postedBy,
        version: expectedVersion + 1,
      })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: row.id,
        companyId: row.companyId,
        version: expectedVersion,
      })
      .execute();
    if (!res.affected) {
      throw new OptimisticLockConflictError(`Payment ${row.id} was modified concurrently`, { id: row.id });
    }

    // Allocations are only meaningful post-binding — wholly replace them with the current values.
    await m.getRepository(PaymentAllocationOrmEntity).delete({ paymentVoucherId: row.id });
    const allocations = PaymentMapper.allocationsToOrm(payment);
    if (allocations.length) await m.getRepository(PaymentAllocationOrmEntity).insert(allocations);
  }

  async findById(id: string, companyId: string): Promise<PaymentVoucher | null> {
    const m = getManager(this.dataSource);
    const row = await m
      .getRepository(PaymentVoucherOrmEntity)
      .findOne({ where: { id, companyId, deletedAt: null } as never });
    if (!row) return null;
    const allocations = await m.getRepository(PaymentAllocationOrmEntity).find({ where: { paymentVoucherId: id } });
    return PaymentMapper.toDomain(row, allocations);
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<PaymentVoucher | null> {
    const m = getManager(this.dataSource);
    const row = await m
      .getRepository(PaymentVoucherOrmEntity)
      .createQueryBuilder('p')
      .setLock('pessimistic_write')
      .where('p.id = :id AND p.company_id = :companyId AND p.deleted_at IS NULL', { id, companyId })
      .getOne();
    if (!row) return null;
    const allocations = await m.getRepository(PaymentAllocationOrmEntity).find({ where: { paymentVoucherId: id } });
    return PaymentMapper.toDomain(row, allocations);
  }

  async delete(id: string, companyId: string): Promise<void> {
    const m = getManager(this.dataSource);
    // payment_allocation cascades on the voucher delete, but remove explicitly to be independent of the FK.
    await m.getRepository(PaymentAllocationOrmEntity).delete({ paymentVoucherId: id });
    await m.getRepository(PaymentVoucherOrmEntity).delete({ id, companyId } as never);
  }
}
