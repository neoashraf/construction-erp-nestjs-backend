/**
 * PaymentAllocationOrmEntity — the PAY `payment_allocation` table (INFRASTRUCTURE): one row per settled
 * payable on a payment voucher. The resolved control account / dims / party / accrued binding is persisted
 * here (re-derived authoritatively at post, but stored so a loaded draft carries it). Money columns are
 * numeric(18,4) via moneyTransformer. No version column — allocations are only meaningful post-binding and
 * are wholly replaced on each save. CHECKs + FKs (payment_voucher_id ON DELETE CASCADE; party/project/
 * cost_centre/purpose ON DELETE RESTRICT; NO FK on payable_id — polymorphic) live in the migration.
 */
import Decimal from 'decimal.js';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'payment_allocation' })
@Index('idx_payment_allocation_voucher', ['paymentVoucherId'])
@Index('idx_payment_allocation_payable', ['payableType', 'payableId'])
export class PaymentAllocationOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'payment_voucher_id', type: 'uuid' }) paymentVoucherId!: string;
  @Column({ name: 'line_no', type: 'int' }) lineNo!: number;
  @Column({ name: 'payable_type', type: 'varchar' }) payableType!: string;
  @Column({ name: 'payable_id', type: 'uuid' }) payableId!: string;
  @Column({ name: 'amount_allocated', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  amountAllocated!: Decimal;
  @Column({
    name: 'accrued_amount',
    type: 'numeric',
    precision: 18,
    scale: 4,
    nullable: true,
    transformer: moneyTransformer,
  })
  accruedAmount!: Decimal | null;
  @Column({ name: 'party_id', type: 'uuid', nullable: true }) partyId!: string | null;
  @Column({ name: 'project_id', type: 'uuid', nullable: true }) projectId!: string | null;
  @Column({ name: 'cost_centre_id', type: 'uuid', nullable: true }) costCentreId!: string | null;
  @Column({ name: 'purpose_id', type: 'uuid', nullable: true }) purposeId!: string | null;
  @Column({ name: 'control_account_id', type: 'uuid', nullable: true }) controlAccountId!: string | null;
  @Column({ name: 'control_account_type', type: 'varchar', nullable: true }) controlAccountType!: string | null;
  @Column({ name: 'is_control_account', type: 'boolean', nullable: true }) isControlAccount!: boolean | null;
}
