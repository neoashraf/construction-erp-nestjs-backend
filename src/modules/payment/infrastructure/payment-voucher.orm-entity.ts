/**
 * PaymentVoucherOrmEntity — the PAY `payment_voucher` table (INFRASTRUCTURE). PAY owns only this voucher
 * row + its `payment_allocation` children; the posted ledger entry is LED's (linked by journal_entry_id,
 * null until posted). Money columns are numeric(18,4) via moneyTransformer (string <-> Decimal, exact —
 * never float). The status/payment-mode CHECKs, the cheque-ref CHECK, FKs (ON DELETE RESTRICT), and the §7
 * indexes live in the migration.
 */
import Decimal from 'decimal.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'payment_voucher' })
@Index('idx_payment_voucher_company_fy', ['companyId', 'financialYearId'])
@Index('idx_payment_voucher_company_fy_date', ['companyId', 'financialYearId', 'paymentDate'])
@Index('idx_payment_voucher_party', ['partyId'])
@Index('idx_payment_voucher_payment_account', ['paymentAccountId'])
@Index('idx_payment_voucher_company_status', ['companyId', 'status'])
@Index('idx_payment_voucher_journal_entry', ['journalEntryId'])
@Index('idx_payment_voucher_entry_no', ['entryNo'])
export class PaymentVoucherOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'company_id', type: 'uuid' }) companyId!: string;
  @Column({ name: 'financial_year_id', type: 'uuid' }) financialYearId!: string;
  @Column({ name: 'party_id', type: 'uuid', nullable: true }) partyId!: string | null;
  @Column({ name: 'payment_date', type: 'date' }) paymentDate!: string;
  @Column({ name: 'payment_mode', type: 'varchar' }) paymentMode!: string;
  @Column({ name: 'payment_account_id', type: 'uuid' }) paymentAccountId!: string;
  @Column({ name: 'cheque_txn_ref', type: 'varchar', nullable: true }) chequeTxnRef!: string | null;
  @Column({ name: 'bank_charges_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  bankChargesAmount!: Decimal;
  @Column({ name: 'bank_charges_project_id', type: 'uuid', nullable: true }) bankChargesProjectId!: string | null;
  @Column({ name: 'bank_charges_cost_centre_id', type: 'uuid', nullable: true }) bankChargesCostCentreId!:
    | string
    | null;
  @Column({ name: 'bank_charges_purpose_id', type: 'uuid', nullable: true }) bankChargesPurposeId!: string | null;
  @Column({ name: 'payment_amount', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  paymentAmount!: Decimal;
  @Column({ name: 'narration', type: 'text', nullable: true }) narration!: string | null;
  @Column({ name: 'status', type: 'varchar' }) status!: string;
  @Column({ name: 'entry_no', type: 'varchar', nullable: true }) entryNo!: string | null;
  @Column({ name: 'journal_entry_id', type: 'uuid', nullable: true }) journalEntryId!: string | null;
  @Column({ name: 'posted_at', type: 'timestamptz', nullable: true }) postedAt!: Date | null;
  @Column({ name: 'posted_by', type: 'uuid', nullable: true }) postedBy!: string | null;
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @VersionColumn({ name: 'version', type: 'int' }) version!: number;
}
