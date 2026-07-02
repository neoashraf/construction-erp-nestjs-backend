/**
 * PaymentMapper (INFRASTRUCTURE) — translates the pure PaymentVoucher aggregate <-> the `payment_voucher`
 * row + its `payment_allocation` rows. The domain never imports TypeORM; this is the only seam. Money <->
 * Decimal is exact via the ORM transformer. Allocation rows get a fresh UUID on write (they are wholly
 * replaced on each save).
 */
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { Money } from '../../../common/money';
import { AccountType } from '../../../core/posting/domain/posting-command';
import { PaymentAllocation, PayableType } from '../domain/allocation';
import { PaymentMode } from '../domain/payment-mode';
import { PaymentStatus, PaymentVoucher } from '../domain/payment-voucher';
import { PaymentVoucherOrmEntity } from './payment-voucher.orm-entity';
import { PaymentAllocationOrmEntity } from './payment-allocation.orm-entity';

export const PaymentMapper = {
  toOrm(payment: PaymentVoucher): PaymentVoucherOrmEntity {
    const p = payment.props;
    const e = new PaymentVoucherOrmEntity();
    e.id = payment.id;
    e.companyId = p.companyId;
    e.financialYearId = p.financialYearId;
    e.partyId = p.partyId;
    e.paymentDate = p.paymentDate;
    e.paymentMode = p.paymentMode;
    e.paymentAccountId = p.paymentAccountId;
    e.chequeTxnRef = p.chequeTxnRef;
    e.bankChargesAmount = p.bankChargesAmount.amount;
    e.bankChargesProjectId = p.bankChargesProjectId;
    e.bankChargesCostCentreId = p.bankChargesCostCentreId;
    e.bankChargesPurposeId = p.bankChargesPurposeId;
    e.paymentAmount = p.paymentAmount.amount;
    e.narration = p.narration;
    e.status = p.status;
    e.entryNo = p.entryNo;
    e.journalEntryId = p.journalEntryId;
    e.postedAt = p.postedAt;
    e.postedBy = p.postedBy;
    e.deletedAt = null;
    return e;
  },

  allocationsToOrm(payment: PaymentVoucher): PaymentAllocationOrmEntity[] {
    return payment.props.allocations.map((a) => {
      const e = new PaymentAllocationOrmEntity();
      e.id = randomUUID();
      e.paymentVoucherId = payment.id;
      e.lineNo = a.lineNo;
      e.payableType = a.payableType;
      e.payableId = a.payableId;
      e.amountAllocated = a.amountAllocated.amount;
      e.accruedAmount = a.accruedAmount ? a.accruedAmount.amount : null;
      e.partyId = a.partyId;
      e.projectId = a.projectId;
      e.costCentreId = a.costCentreId;
      e.purposeId = a.purposeId;
      e.controlAccountId = a.controlAccountId ?? null;
      e.controlAccountType = a.controlAccountType ?? null;
      e.isControlAccount = a.isControlAccount ?? null;
      return e;
    });
  },

  toDomain(row: PaymentVoucherOrmEntity, allocationRows: PaymentAllocationOrmEntity[]): PaymentVoucher {
    const allocations: PaymentAllocation[] = allocationRows
      .slice()
      .sort((x, y) => x.lineNo - y.lineNo)
      .map((a) => ({
        lineNo: a.lineNo,
        payableType: a.payableType as PayableType,
        payableId: a.payableId,
        amountAllocated: Money.of(new Decimal(a.amountAllocated)),
        accruedAmount: a.accruedAmount !== null ? Money.of(new Decimal(a.accruedAmount)) : null,
        partyId: a.partyId,
        projectId: a.projectId,
        costCentreId: a.costCentreId,
        purposeId: a.purposeId,
        controlAccountId: a.controlAccountId ?? undefined,
        controlAccountType: (a.controlAccountType as AccountType | null) ?? undefined,
        isControlAccount: a.isControlAccount ?? undefined,
      }));

    return PaymentVoucher.rehydrate(row.id, {
      companyId: row.companyId,
      financialYearId: row.financialYearId,
      partyId: row.partyId,
      paymentDate: row.paymentDate,
      paymentMode: row.paymentMode as PaymentMode,
      paymentAccountId: row.paymentAccountId,
      chequeTxnRef: row.chequeTxnRef,
      bankChargesAmount: Money.of(new Decimal(row.bankChargesAmount)),
      bankChargesProjectId: row.bankChargesProjectId,
      bankChargesCostCentreId: row.bankChargesCostCentreId,
      bankChargesPurposeId: row.bankChargesPurposeId,
      paymentAmount: Money.of(new Decimal(row.paymentAmount)),
      narration: row.narration,
      status: row.status as PaymentStatus,
      entryNo: row.entryNo,
      journalEntryId: row.journalEntryId,
      postedAt: row.postedAt,
      postedBy: row.postedBy,
      allocations,
      version: row.version,
    });
  },
};
