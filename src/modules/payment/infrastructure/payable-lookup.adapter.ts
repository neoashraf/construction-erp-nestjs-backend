/**
 * PayableLookupAdapter (INFRASTRUCTURE) — implements PayableLookupPort by reading the source modules' ORM
 * entities directly (PUR purchase_bill, HR labour_payable, HR salary_sheet + salary_sheet_line), mirroring
 * REC's cross-module ORM-entity read of SAL. `remainingOutstanding = originalAmount − Σ(PAY's OWN posted,
 * non-reversed payment_allocation applied to this payable)`, computed here in raw SQL against PAY's own
 * tables (the reversal NOT EXISTS on journal_entry) — until #28 wires the reverse seam. Control accounts
 * are resolved by well-known CoA code; the daily-labour purpose is read from the accrual entry's
 * Labour-Cost journal line. Enrols in the active UoW via getManager.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Money } from '../../../common/money';
import { PayableType } from '../domain/allocation';
import { PayableLookupPort, ResolvedPayable } from '../domain/ports/payable-lookup.port';
import { PaymentAccountNotConfiguredError } from '../domain/errors';
import { AccountOrmEntity } from '../../master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { PurchaseBillOrmEntity } from '../../purchase/infrastructure/purchase-bill.orm-entity';
import { LabourPayableOrmEntity } from '../../hr/infrastructure/labour-payable.orm-entity';
import { SalarySheetOrmEntity } from '../../hr/infrastructure/salary-sheet.orm-entity';
import { WELL_KNOWN_PAYMENT_ACCOUNTS } from './well-known-payment-accounts';

@Injectable()
export class PayableLookupAdapter implements PayableLookupPort {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async resolve(payableType: PayableType, payableId: string, companyId: string): Promise<ResolvedPayable | null> {
    switch (payableType) {
      case 'PURCHASE_BILL':
        return this.resolvePurchaseBill(payableId, companyId);
      case 'LABOUR_PAYABLE':
        return this.resolveLabourPayable(payableId, companyId);
      case 'SALARY':
        return this.resolveSalary(payableId, companyId);
      default:
        return null;
    }
  }

  private async resolvePurchaseBill(payableId: string, companyId: string): Promise<ResolvedPayable | null> {
    const bill = await getManager(this.dataSource)
      .getRepository(PurchaseBillOrmEntity)
      .findOne({ where: { id: payableId, companyId } });
    if (!bill) return null;

    const controlAccountId = await this.accountIdByCode(companyId, WELL_KNOWN_PAYMENT_ACCOUNTS.accountsPayableCode, 'accounts payable control');
    const original = Money.of(new Decimal(bill.netPayableAmount));
    const applied = await this.appliedTotal(companyId, 'PURCHASE_BILL', payableId);
    return {
      controlAccountId,
      controlAccountType: 'LIABILITY',
      isControlAccount: true,
      partyId: bill.supplierId,
      projectId: null,
      costCentreId: null,
      purposeId: null,
      accruedAmount: null,
      originalAmount: original,
      remainingOutstanding: clampZero(original.minus(applied)),
      posted: bill.status === 'POSTED',
    };
  }

  private async resolveLabourPayable(payableId: string, companyId: string): Promise<ResolvedPayable | null> {
    const lp = await getManager(this.dataSource)
      .getRepository(LabourPayableOrmEntity)
      .findOne({ where: { id: payableId, companyId } });
    if (!lp) return null;

    const controlAccountId = await this.accountIdByCode(companyId, WELL_KNOWN_PAYMENT_ACCOUNTS.dailyLabourPayableCode, 'daily-labour payable');
    const accrued = Money.of(new Decimal(lp.accruedAmount));
    const applied = await this.appliedTotal(companyId, 'LABOUR_PAYABLE', payableId);
    const purposeId = await this.accrualLinePurpose(companyId, lp.accrualEntryId);
    return {
      controlAccountId,
      controlAccountType: 'LIABILITY',
      isControlAccount: false,
      partyId: null,
      projectId: lp.projectId,
      costCentreId: lp.costCentreId,
      purposeId,
      accruedAmount: accrued,
      originalAmount: accrued,
      remainingOutstanding: clampZero(accrued.minus(applied)),
      posted: true, // a labour_payable row exists = confirmed accrual
    };
  }

  private async resolveSalary(payableId: string, companyId: string): Promise<ResolvedPayable | null> {
    const m = getManager(this.dataSource);
    const sheet = await m.getRepository(SalarySheetOrmEntity).findOne({ where: { id: payableId, companyId } });
    if (!sheet) return null;

    const controlAccountId = await this.accountIdByCode(companyId, WELL_KNOWN_PAYMENT_ACCOUNTS.salaryPayableCode, 'salary payable');
    const netRows: Array<{ net: string }> = await m.query(
      `SELECT COALESCE(SUM(net_amount), 0)::text AS net FROM salary_sheet_line WHERE salary_sheet_id = $1`,
      [payableId],
    );
    const original = Money.of(new Decimal(netRows[0]?.net ?? '0'));
    const applied = await this.appliedTotal(companyId, 'SALARY', payableId);
    return {
      controlAccountId,
      controlAccountType: 'LIABILITY',
      isControlAccount: false,
      partyId: null,
      projectId: null,
      costCentreId: null,
      purposeId: null,
      accruedAmount: null,
      originalAmount: original,
      remainingOutstanding: clampZero(original.minus(applied)),
      posted: sheet.status === 'POSTED',
    };
  }

  /** Σ amount_allocated of PAY's OWN posted, non-reversed payments applied to this payable. */
  private async appliedTotal(companyId: string, payableType: PayableType, payableId: string): Promise<Money> {
    const rows: Array<{ applied: string | null }> = await getManager(this.dataSource).query(
      `SELECT COALESCE(SUM(pa.amount_allocated), 0)::text AS applied
         FROM payment_allocation pa
         JOIN payment_voucher pv ON pv.id = pa.payment_voucher_id
         JOIN journal_entry je ON je.id = pv.journal_entry_id
        WHERE pv.company_id = $1
          AND pa.payable_type = $2
          AND pa.payable_id = $3
          AND pv.status = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM journal_entry rev WHERE rev.reversal_of = je.id)`,
      [companyId, payableType, payableId],
    );
    return Money.of(new Decimal(rows[0]?.applied ?? '0'));
  }

  /** The purpose tagged on the accrual entry's Labour-Cost line (fallback: any line's purpose on that entry). */
  private async accrualLinePurpose(companyId: string, accrualEntryId: string): Promise<string | null> {
    const m = getManager(this.dataSource);
    const labourCostId = await this.accountIdByCode(companyId, WELL_KNOWN_PAYMENT_ACCOUNTS.labourCostCode, 'labour cost');
    const rows: Array<{ purpose_id: string | null }> = await m.query(
      `SELECT purpose_id FROM journal_line WHERE journal_entry_id = $1 AND account_id = $2 LIMIT 1`,
      [accrualEntryId, labourCostId],
    );
    if (rows[0]?.purpose_id) return rows[0].purpose_id;
    const anyRows: Array<{ purpose_id: string | null }> = await m.query(
      `SELECT purpose_id FROM journal_line WHERE journal_entry_id = $1 AND purpose_id IS NOT NULL LIMIT 1`,
      [accrualEntryId],
    );
    return anyRows[0]?.purpose_id ?? null;
  }

  private async accountIdByCode(companyId: string, code: string, role: string): Promise<string> {
    const row = await getManager(this.dataSource)
      .getRepository(AccountOrmEntity)
      .findOne({ where: { companyId, code } });
    if (!row) throw new PaymentAccountNotConfiguredError(role);
    return row.id;
  }
}

function clampZero(m: Money): Money {
  return m.amount.isNegative() ? Money.zero() : m;
}
