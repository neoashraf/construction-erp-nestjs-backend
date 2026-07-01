/**
 * buildPurchaseBillCommand — the ONLY place the PURCHASE Dr/Cr mapping lives (PURE — turns a PurchaseBill
 * into a balanced PostingCommand). Mirrors the technical-design §4.1 worked template line-for-line and
 * NEVER emits a zero-value line, so a bill with no TDS/AIT simply has fewer lines while still balancing.
 *
 * The §4.1 form (the doc's chosen, test-locked form):
 *   1..N. Dr Inventory (per stock line, tagged project+cost_centre+purpose+GODOWN) — or
 *         Dr <line's own expense account> (per non-stock line, tagged project+cost_centre+purpose, no godown)
 *   N+1.  Dr VAT Input (recoverable)                    = Σ vatInputAmount            [dims, no godown]
 *   N+2.  Cr Accounts Payable (control)                 = netPayableAmount   [party=supplier, no godown]
 *   N+3.  Cr TDS Payable                                = Σ tdsAmount                 [dims, no godown]
 *   N+4.  Cr AIT Payable                                = Σ aitAmount                 [dims, no godown]
 *
 * AP is credited with the bill's netPayableAmount — the RESIDUAL the aggregate already derived
 * (gross + vatInput - tds - ait) — so the command balances by construction: Σ(inventory/expense debits) +
 * vatInput = netPayable + tds + ait (FR-PUR-007, FR-PUR-012). Every inventory line carries all four
 * dimensions INCLUDING godown; every other line (expense/VAT-input/AP/TDS/AIT) carries project+cost_centre+
 * purpose but NO godown (design §4.1's worked table — those rows show godown "-"; architectural decision 5
 * — the tag-matrix's PURCHASE-per-line special case enforces this via the `isStockLine` hint on each
 * PostingLine). `accountType`/`isControlAccount` hints let LED's TagMatrix apply the §5.1 rules without a
 * lookup, mirroring SAL's `buildIpcCommand` exactly.
 */
import { Money } from '../../../common/money';
import { PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { PurchaseBill, PURCHASE_BILL_SOURCE_TYPE } from './purchase-bill';

/** The four resolved non-inventory purchase posting-account ids (MAS), injected per company (FR-PUR-009). */
export interface PurchaseAccountMap {
  vatInputRecoverable: string;
  accountsPayable: string;
  tdsPayable: string;
  aitPayable: string;
  /** MAS item/godown -> inventory control account (delegates to INV's InventoryAccountResolver). */
  inventoryOf(itemId: string, godownId: string): Promise<string>;
}

export async function buildPurchaseBillCommand(
  bill: PurchaseBill,
  accounts: PurchaseAccountMap,
  postedBy: string,
): Promise<PostingCommand> {
  const p = bill.props;
  const party = p.supplierId;

  const lines: PostingLine[] = [];

  // 1..N. Dr Inventory (stock lines, godown) / Dr expense account (non-stock lines, no godown).
  for (const line of bill.lines) {
    const dims = { projectId: line.projectId, costCentreId: line.costCentreId, purposeId: line.purposeId };
    if (line.isStockLine) {
      const inventoryAccountId = await accounts.inventoryOf(line.itemId as string, line.godownId as string);
      lines.push({
        accountId: inventoryAccountId,
        ...dims,
        godownId: line.godownId as string,
        debit: Money.of(line.lineAmount),
        credit: Money.zero(),
        accountType: 'ASSET',
        isControlAccount: false,
        isStockLine: true,
      });
    } else {
      lines.push({
        accountId: line.expenseAccountId as string,
        ...dims,
        debit: Money.of(line.lineAmount),
        credit: Money.zero(),
        accountType: 'EXPENSE',
        isControlAccount: false,
        isStockLine: false,
      });
    }
  }

  // Header-level dims for the non-line-specific VAT/AP/TDS/AIT lines: the bill's own project/cost-centre/
  // purpose is not stored at header level (SRS §8 — only per-line), so use the FIRST line's dims (every
  // line of a single bill shares the same purchase transaction/location per the worked example) — mirrors
  // how SAL's buildIpcCommand uses the IPC's single header dims; PUR has per-line dims, so we fold to the
  // first line's, consistent across the whole bill in the common (single-dimension-set) case.
  const headerDims = {
    projectId: bill.lines[0].projectId,
    costCentreId: bill.lines[0].costCentreId,
    purposeId: bill.lines[0].purposeId,
  };

  // N+1. Dr VAT Input (recoverable) — omit when zero.
  if (p.vatInputAmount.amount.greaterThan(0)) {
    lines.push({
      accountId: accounts.vatInputRecoverable,
      ...headerDims,
      debit: Money.of(p.vatInputAmount.amount),
      credit: Money.zero(),
      accountType: 'ASSET',
      isControlAccount: false,
      isStockLine: false,
    });
  }

  // N+2. Cr Accounts Payable (control), party = supplier — the residual net payable. Always present.
  lines.push({
    accountId: accounts.accountsPayable,
    ...headerDims,
    partyId: party,
    debit: Money.zero(),
    credit: Money.of(p.netPayableAmount.amount),
    accountType: 'LIABILITY',
    isControlAccount: true,
    isStockLine: false,
  });

  // N+3. Cr TDS Payable — omit when zero.
  if (p.tdsAmount.amount.greaterThan(0)) {
    lines.push({
      accountId: accounts.tdsPayable,
      ...headerDims,
      debit: Money.zero(),
      credit: Money.of(p.tdsAmount.amount),
      accountType: 'LIABILITY',
      isControlAccount: false,
      isStockLine: false,
    });
  }

  // N+4. Cr AIT Payable — omit when zero.
  if (p.aitAmount.amount.greaterThan(0)) {
    lines.push({
      accountId: accounts.aitPayable,
      ...headerDims,
      debit: Money.zero(),
      credit: Money.of(p.aitAmount.amount),
      accountType: 'LIABILITY',
      isControlAccount: false,
      isStockLine: false,
    });
  }

  return {
    companyId: p.companyId,
    financialYearId: p.financialYearId,
    voucherType: 'PURCHASE',
    voucherDate: p.billDate,
    sourceType: PURCHASE_BILL_SOURCE_TYPE,
    sourceId: bill.id,
    postedBy,
    narration: p.narration ?? undefined,
    lines,
  };
}
