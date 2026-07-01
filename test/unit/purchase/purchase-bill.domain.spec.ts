/**
 * PUR domain unit tests (no DB, no Nest) — the PurchaseBill aggregate money math + lifecycle +
 * buildPurchaseBillCommand. Cites FR-PUR-004..012, -024. Covers: the §4.1 figures + residual net payable
 * (AC2); buildPurchaseBillCommand equals §4.1 & balances at 247,250 with the four dims incl. godown on
 * inventory lines + supplier party on AP (AC1, AC3); zero-line omission; non-stock/mixed line (AC8);
 * net-payable-non-negative + line-type guards; lifecycle guards (AC14).
 */
import Decimal from 'decimal.js';
import {
  NewPurchaseBill,
  NewPurchaseBillLine,
  PurchaseBill,
} from '../../../src/modules/purchase/domain/purchase-bill';
import { buildPurchaseBillCommand, PurchaseAccountMap } from '../../../src/modules/purchase/domain/bill-posting';
import { PurchaseTax } from '../../../src/modules/purchase/domain/tax';
import {
  LineTypeError,
  NetPayableNegativeError,
  NotDraftError,
  NotPostedError,
} from '../../../src/modules/purchase/domain/errors';
import { ValidationError } from '../../../src/common/errors/domain-error';

const CO = 'co1';
const FY = 'fy1';
const PROJECT = 'p-01';
const SUPPLIER = 'supp-x';
const CC = 'cc-slab';
const PURPOSE = 'pur-day20-pour';
const GODOWN = 'g-site-a';

// design §4.1 worked example: VAT input 7.5%, TDS 5%, AIT 2%.
const TAX = PurchaseTax.of({ vatInputPct: '7.5', tdsPct: '5', aitPct: '2' });

const ACCOUNTS: PurchaseAccountMap = {
  vatInputRecoverable: 'acc-vat-input',
  accountsPayable: 'acc-ap',
  tdsPayable: 'acc-tds',
  aitPayable: 'acc-ait',
  inventoryOf: async (_itemId: string, _godownId: string) => 'acc-inventory',
};

function stockLine(overrides: Partial<NewPurchaseBillLine> = {}): NewPurchaseBillLine {
  return {
    itemId: 'item-cement',
    isStockLine: true,
    billedQty: '100',
    rate: '500',
    godownId: GODOWN,
    projectId: PROJECT,
    costCentreId: CC,
    purposeId: PURPOSE,
    ...overrides,
  };
}

function rodLine(overrides: Partial<NewPurchaseBillLine> = {}): NewPurchaseBillLine {
  return {
    itemId: 'item-rod',
    isStockLine: true,
    billedQty: '2',
    rate: '90000',
    godownId: GODOWN,
    projectId: PROJECT,
    costCentreId: CC,
    purposeId: PURPOSE,
    ...overrides,
  };
}

function baseInput(overrides: Partial<NewPurchaseBill> = {}): NewPurchaseBill {
  return {
    projectId: PROJECT,
    supplierId: SUPPLIER,
    supplierInvoiceRef: 'INV-7741',
    billDate: '2026-06-29',
    dueDate: '2026-07-29',
    lines: [stockLine(), rodLine()],
    ...overrides,
  };
}

function draft(overrides: Partial<NewPurchaseBill> = {}, ids: string[] = ['l1', 'l2', 'l3', 'l4']): PurchaseBill {
  return PurchaseBill.createDraft('bill-1', CO, FY, baseInput(overrides), TAX, ids);
}

describe('PurchaseBill — §4.1 figures & residual net payable (AC2, FR-PUR-007)', () => {
  it('computes gross 230,000, VAT input 17,250, TDS 11,500, AIT 4,600, netPayable 231,150 exactly', () => {
    const bill = draft();
    const p = bill.props;
    expect(p.grossAmount.amount.toFixed(4)).toBe('230000.0000'); // 50,000 + 180,000
    expect(p.vatInputAmount.amount.toFixed(4)).toBe('17250.0000'); // 7.5% × 230,000
    expect(p.tdsAmount.amount.toFixed(4)).toBe('11500.0000'); // 5% × 230,000
    expect(p.aitAmount.amount.toFixed(4)).toBe('4600.0000'); // 2% × 230,000
    // netPayable = 230,000 + 17,250 − 11,500 − 4,600 = 231,150
    expect(p.netPayableAmount.amount.toFixed(4)).toBe('231150.0000');
    expect(p.status).toBe('DRAFT');
    expect(p.entryNo).toBeNull();
    expect(p.journalEntryId).toBeNull();
  });

  it('records per-line overridden tax amounts exactly', () => {
    const bill = draft({
      lines: [stockLine({ vatInputAmount: '4000', tdsAmount: '2600', aitAmount: '1100' }), rodLine()],
    });
    // line1 override 4000/2600/1100; line2 default 7.5%/5%/2% of 180,000 = 13500/9000/3600
    expect(bill.props.vatInputAmount.amount.toFixed(4)).toBe('17500.0000'); // 4000+13500
    expect(bill.props.tdsAmount.amount.toFixed(4)).toBe('11600.0000'); // 2600+9000
    expect(bill.props.aitAmount.amount.toFixed(4)).toBe('4700.0000'); // 1100+3600
  });

  it('rejects TDS/AIT that would drive net payable below 0 (edge case 11)', () => {
    expect(() =>
      draft({ lines: [stockLine({ billedQty: '1', rate: '100', tdsAmount: '90', aitAmount: '20' })] }),
    ).toThrow(NetPayableNegativeError);
  });

  it('rejects a bill with zero lines', () => {
    expect(() => draft({ lines: [] })).toThrow(ValidationError);
  });

  it('rejects a stock line with billedQty <= 0', () => {
    expect(() => draft({ lines: [stockLine({ billedQty: '0' })] })).toThrow(ValidationError);
  });
});

describe('PurchaseBill — line type guards (FR-PUR-005, §11)', () => {
  it('rejects a line with both itemId and expenseAccountId', () => {
    expect(() =>
      draft({
        lines: [stockLine({ expenseAccountId: 'acc-x' })],
      }),
    ).toThrow(LineTypeError);
  });

  it('rejects a line with neither itemId nor expenseAccountId', () => {
    expect(() =>
      draft({
        lines: [stockLine({ itemId: null })],
      }),
    ).toThrow(LineTypeError);
  });

  it('rejects a stock line missing godownId', () => {
    expect(() => draft({ lines: [stockLine({ godownId: null })] })).toThrow(ValidationError);
  });

  it('accepts a non-stock (expense) line with no godown', () => {
    const bill = draft({
      lines: [
        {
          expenseAccountId: 'acc-service',
          isStockLine: false,
          billedQty: '1',
          rate: '8000',
          projectId: PROJECT,
          costCentreId: CC,
          purposeId: PURPOSE,
        },
      ],
    });
    expect(bill.lines[0].isStockLine).toBe(false);
    expect(bill.lines[0].godownId).toBeNull();
  });

  it('supports a mixed stock + non-stock bill (edge case 10)', () => {
    const bill = draft({
      lines: [
        stockLine(),
        {
          expenseAccountId: 'acc-service',
          isStockLine: false,
          billedQty: '1',
          rate: '8000',
          projectId: PROJECT,
          costCentreId: CC,
          purposeId: PURPOSE,
        },
      ],
    });
    expect(bill.stockLines()).toHaveLength(1);
    expect(bill.lines).toHaveLength(2);
  });
});

describe('PurchaseBill — lifecycle guards (AC14, FR-PUR-024)', () => {
  it('markPosted only from DRAFT; a second post throws NotDraftError', () => {
    const bill = draft();
    bill.markPosted('entry-1', 'PUR/2526/0042', 'u1', new Date());
    expect(bill.props.status).toBe('POSTED');
    expect(bill.props.entryNo).toBe('PUR/2526/0042');
    expect(() => bill.markPosted('entry-2', 'PUR/2526/0043', 'u1', new Date())).toThrow(NotDraftError);
  });

  it('updateDraft rejected on a POSTED bill', () => {
    const bill = draft();
    bill.markPosted('entry-1', 'PUR/2526/0042', 'u1', new Date());
    expect(() => bill.updateDraft({ narration: 'x' }, TAX, ['l1', 'l2'])).toThrow(NotDraftError);
  });

  it('markCancelled only from POSTED', () => {
    const bill = draft();
    expect(() => bill.markCancelled()).toThrow(NotPostedError);
    bill.markPosted('entry-1', 'PUR/2526/0042', 'u1', new Date());
    bill.markCancelled();
    expect(bill.props.status).toBe('CANCELLED');
  });

  it('assertPostable requires DRAFT + at least one line', () => {
    const bill = draft();
    expect(() => bill.assertPostable()).not.toThrow();
    bill.markPosted('entry-1', 'PUR/2526/0042', 'u1', new Date());
    expect(() => bill.assertPostable()).toThrow(NotDraftError);
  });

  it('updateDraft recomputes figures on the new lines', () => {
    const bill = draft();
    bill.updateDraft({ lines: [stockLine({ billedQty: '200' })] }, TAX, ['l1']);
    expect(bill.props.grossAmount.amount.toFixed(4)).toBe('100000.0000'); // 200 × 500
  });
});

describe('PurchaseBill.costLines / stockLines (CC + INV seams)', () => {
  it('costLines returns one entry per line for the budget check', () => {
    const bill = draft();
    const costLines = bill.costLines();
    expect(costLines).toHaveLength(2);
    expect(costLines[0]).toMatchObject({ projectId: PROJECT, costCentreId: CC });
    expect(costLines[0].amount.toFixed(4)).toBe('50000.0000');
  });

  it('stockLines returns only the item-tracked lines', () => {
    const bill = draft();
    expect(bill.stockLines()).toHaveLength(2);
  });
});

describe('buildPurchaseBillCommand — the §4.1 template (AC1, AC3, FR-PUR-009/-010/-012)', () => {
  it('emits the §4.1 lines, balanced at 247,250, with the four dims incl. godown on inventory + AP party', async () => {
    const bill = draft();
    const cmd = await buildPurchaseBillCommand(bill, ACCOUNTS, 'u1');
    expect(cmd.voucherType).toBe('PURCHASE');

    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.toFixed(4)).toBe('247250.0000');
    expect(cr.toFixed(4)).toBe('247250.0000');
    expect(dr.equals(cr)).toBe(true);

    // Two inventory lines: 50,000 (cement) + 180,000 (rod), each with all 4 dims incl. godown.
    const invLines = cmd.lines.filter((l) => l.accountId === 'acc-inventory');
    expect(invLines).toHaveLength(2);
    for (const l of invLines) {
      expect(l.projectId).toBe(PROJECT);
      expect(l.costCentreId).toBe(CC);
      expect(l.purposeId).toBe(PURPOSE);
      expect(l.godownId).toBe(GODOWN);
      expect(l.partyId).toBeUndefined();
    }
    expect(invLines.map((l) => l.debit.amount.toFixed(4)).sort()).toEqual(['180000.0000', '50000.0000']);

    // VAT input debit — dims, no godown, no party.
    const vat = cmd.lines.find((l) => l.accountId === ACCOUNTS.vatInputRecoverable);
    expect(vat?.debit.amount.toFixed(4)).toBe('17250.0000');
    expect(vat?.godownId).toBeUndefined();
    expect(vat?.partyId).toBeUndefined();

    // AP credit — party = supplier, no godown, net payable 231,150.
    const ap = cmd.lines.find((l) => l.accountId === ACCOUNTS.accountsPayable);
    expect(ap?.credit.amount.toFixed(4)).toBe('231150.0000');
    expect(ap?.partyId).toBe(SUPPLIER);
    expect(ap?.godownId).toBeUndefined();
    expect(ap?.isControlAccount).toBe(true);

    // TDS / AIT credits — dims, no godown, no party.
    const tds = cmd.lines.find((l) => l.accountId === ACCOUNTS.tdsPayable);
    expect(tds?.credit.amount.toFixed(4)).toBe('11500.0000');
    expect(tds?.godownId).toBeUndefined();
    const ait = cmd.lines.find((l) => l.accountId === ACCOUNTS.aitPayable);
    expect(ait?.credit.amount.toFixed(4)).toBe('4600.0000');
    expect(ait?.godownId).toBeUndefined();
  });

  it('marks every inventory line isStockLine=true and every other line isStockLine=false (tag-matrix hint)', async () => {
    const cmd = await buildPurchaseBillCommand(draft(), ACCOUNTS, 'u1');
    const invLines = cmd.lines.filter((l) => l.accountId === 'acc-inventory');
    for (const l of invLines) expect(l.isStockLine).toBe(true);
    const others = cmd.lines.filter((l) => l.accountId !== 'acc-inventory');
    for (const l of others) expect(l.isStockLine).toBe(false);
  });

  it('omits zero-amount TDS/AIT lines and still balances (FR-PUR-006)', async () => {
    const zeroTax = PurchaseTax.of({ vatInputPct: '7.5', tdsPct: '0', aitPct: '0' });
    const bill = PurchaseBill.createDraft('bill-2', CO, FY, baseInput(), zeroTax, ['l1', 'l2']);
    const cmd = await buildPurchaseBillCommand(bill, ACCOUNTS, 'u1');
    expect(cmd.lines.some((l) => l.accountId === ACCOUNTS.tdsPayable)).toBe(false);
    expect(cmd.lines.some((l) => l.accountId === ACCOUNTS.aitPayable)).toBe(false);
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
    expect(dr.equals(cr)).toBe(true);
    // gross 230,000 + VAT 17,250 = 247,250 = AP (net payable, no TDS/AIT deducted)
    expect(dr.toFixed(4)).toBe('247250.0000');
  });

  it('non-stock line debits its own expense account and carries no godown (edge case 10, FR-PUR-005/-009)', async () => {
    const bill = draft({
      lines: [
        stockLine(),
        {
          expenseAccountId: 'acc-service',
          isStockLine: false,
          billedQty: '1',
          rate: '8000',
          projectId: PROJECT,
          costCentreId: CC,
          purposeId: PURPOSE,
        },
      ],
    });
    const cmd = await buildPurchaseBillCommand(bill, ACCOUNTS, 'u1');
    const svc = cmd.lines.find((l) => l.accountId === 'acc-service');
    expect(svc?.debit.amount.toFixed(4)).toBe('8000.0000');
    expect(svc?.godownId).toBeUndefined();
    expect(svc?.isStockLine).toBe(false);
    // Only ONE inventory line now (cement); the service line rolls no inventory.
    expect(cmd.lines.filter((l) => l.accountId === 'acc-inventory')).toHaveLength(1);
  });

  it('every AP control line carries the supplier party (AC1/AC3)', async () => {
    const cmd = await buildPurchaseBillCommand(draft(), ACCOUNTS, 'u1');
    for (const l of cmd.lines) {
      if (l.isControlAccount) expect(l.partyId).toBe(SUPPLIER);
    }
  });
});
