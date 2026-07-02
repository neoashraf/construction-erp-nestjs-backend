/**
 * GRN use-case unit tests (fake ports + fake UnitOfWork/Clock/IdGenerator). Cites FR-PUR-015..018,
 * FR-PUR-024. THE OPTION-(a) INVARIANT (§10 Q4, resolved — see domain/grn.ts): posting/cancelling a GRN
 * performs NO `inventory.receiveIn`/`reverseReceipt` and NO `posting.post`/`reverse` — the use cases do
 * not even take those ports (compile-level guarantee, asserted here via constructor arity AND untouched
 * spies). Also covers: draft defaulting from the referenced bill's open quantities (billed − Σ received,
 * AC3/FR-PUR-018), PO_NOT_BILLABLE, supplier/project mismatch, match-status snapshot at post
 * (UNDER/MATCHED/OVER — AC2/AC6, over-delivery NOT blocked), DRAFT-only lifecycle (AC11), cancel =
 * status flip only.
 */
import Decimal from 'decimal.js';
import { ForbiddenException } from '@nestjs/common';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { AccessPolicy } from '../../../src/core/auth/domain/access-policy';
import { PurchaseBill, NewPurchaseBill } from '../../../src/modules/purchase/domain/purchase-bill';
import { PurchaseOrder, NewPurchaseOrder } from '../../../src/modules/purchase/domain/purchase-order';
import { PurchaseTax } from '../../../src/modules/purchase/domain/tax';
import { Grn, NewGrn } from '../../../src/modules/purchase/domain/grn';
import { PoNotBillableError } from '../../../src/modules/purchase/domain/errors';
import { CreateGrnUseCase } from '../../../src/modules/purchase/application/create-grn.usecase';
import { PostGrnUseCase } from '../../../src/modules/purchase/application/post-grn.usecase';
import { CancelGrnUseCase } from '../../../src/modules/purchase/application/cancel-grn.usecase';

const d = (v: string | number) => new Decimal(v);
const CO = 'co1';
const FY = 'fy1';
const PROJECT = 'p-01';
const SUPPLIER = 'supp-x';

const actor: Actor = {
  userId: 'u-store',
  companyId: CO,
  financialYearId: FY,
  role: 'STORE_KEEPER',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const TAX = PurchaseTax.of({ vatInputPct: '7.5', tdsPct: '5', aitPct: '2' });
const CLOCK = { now: () => new Date('2026-06-29T11:00:00Z') };
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };
function idGen() {
  let n = 0;
  return { next: () => `id-${++n}` };
}

function billInput(): NewPurchaseBill {
  return {
    projectId: PROJECT,
    supplierId: SUPPLIER,
    billDate: '2026-06-29',
    dueDate: '2026-07-29',
    lines: [
      { itemId: 'item-cement', isStockLine: true, billedQty: '100', rate: '500', godownId: 'g-a', projectId: PROJECT, costCentreId: 'cc', purposeId: 'pp' },
      { expenseAccountId: 'acc-exp', isStockLine: false, billedQty: '1', rate: '8000', projectId: PROJECT, costCentreId: 'cc', purposeId: 'pp' },
    ],
  };
}
function bill(): PurchaseBill {
  return PurchaseBill.createDraft('bill-1', CO, FY, billInput(), TAX, ['bl-1', 'bl-2']);
}

function grnInput(overrides: Partial<NewGrn> = {}): NewGrn {
  return {
    projectId: PROJECT,
    supplierId: SUPPLIER,
    purchaseBillId: 'bill-1',
    receiptDate: '2026-06-29',
    lines: [
      { purchaseBillLineId: 'bl-1', itemId: 'item-cement', receivedQty: '90', rate: '500', godownId: 'g-a', costCentreId: 'cc', purposeId: 'pp' },
    ],
    ...overrides,
  };
}

class FakeGrnRepo {
  grn: Grn | null = null;
  saved: Grn[] = [];
  receivedByBillLine = new Map<string, Decimal>();
  insert = jest.fn(async (g: Grn) => {
    this.grn = g;
  });
  save = jest.fn(async (g: Grn) => {
    this.grn = g;
    this.saved.push(g);
  });
  findById = jest.fn(async () => this.grn);
  findByIdForUpdate = jest.fn(async () => this.grn);
  receivedSoFar = jest.fn(async (billLineId: string) => this.receivedByBillLine.get(billLineId) ?? d(0));
}

class FakeBillRepo {
  bill: PurchaseBill | null = null;
  findById = jest.fn(async () => this.bill);
  findByIdForUpdate = jest.fn(async () => this.bill);
  insert = jest.fn();
  save = jest.fn();
  softDelete = jest.fn();
}

class FakePoRepo {
  po: PurchaseOrder | null = null;
  findById = jest.fn(async () => this.po);
  findByIdForUpdate = jest.fn(async () => this.po);
  insert = jest.fn();
  save = jest.fn();
  openLines = jest.fn(async () => this.po?.lines ?? []);
}

const tagConsistency = { assertConsistent: jest.fn(async () => undefined) };

/** Spies that MUST stay untouched — the option-(a) invariant. They are never injected anywhere. */
const inventorySpy = { receiveIn: jest.fn(), reverseReceipt: jest.fn(), issueOut: jest.fn(), reverseIssueOut: jest.fn() };
const postingSpy = { post: jest.fn(), reverse: jest.fn(), repost: jest.fn() };

function makeCreate(grns: FakeGrnRepo, bills: FakeBillRepo, pos: FakePoRepo): CreateGrnUseCase {
  return new CreateGrnUseCase(
    grns as never,
    bills as never,
    pos as never,
    tagConsistency as never,
    new AccessPolicy(),
    audit as never,
    uow as never,
    idGen() as never,
  );
}

afterEach(() => jest.clearAllMocks());

describe('CreateGrnUseCase (FR-PUR-015, FR-PUR-018)', () => {
  it('creates a DRAFT against a bill; validates the bill-line refs; runs tag consistency; audits', async () => {
    const grns = new FakeGrnRepo();
    const bills = new FakeBillRepo();
    bills.bill = bill();
    const { id } = await makeCreate(grns, bills, new FakePoRepo()).execute(grnInput(), actor);
    expect(id).toBeTruthy();
    expect(grns.insert).toHaveBeenCalledTimes(1);
    expect(tagConsistency.assertConsistent).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE', entityType: 'Grn' }));
    expect(grns.grn!.props.status).toBe('DRAFT');
    expect(grns.grn!.lines[0].receivedQty.toFixed(4)).toBe('90.0000');
  });

  it('OMITTED lines default from the bill open quantities: billed 100 − 40 already received -> 60 (FR-PUR-018)', async () => {
    const grns = new FakeGrnRepo();
    grns.receivedByBillLine.set('bl-1', d(40));
    const bills = new FakeBillRepo();
    bills.bill = bill();
    await makeCreate(grns, bills, new FakePoRepo()).execute(grnInput({ lines: undefined }), actor);
    const g = grns.grn!;
    expect(g.lines).toHaveLength(1); // ONLY the stock line — the expense line is not receivable
    expect(g.lines[0].purchaseBillLineId).toBe('bl-1');
    expect(g.lines[0].receivedQty.toFixed(4)).toBe('60.0000');
    expect(g.lines[0].rate.toFixed(4)).toBe('500.0000');
    expect(g.lines[0].godownId).toBe('g-a');
  });

  it('rejects defaulting when the bill has no open quantity left (all received)', async () => {
    const grns = new FakeGrnRepo();
    grns.receivedByBillLine.set('bl-1', d(100));
    const bills = new FakeBillRepo();
    bills.bill = bill();
    await expect(makeCreate(grns, bills, new FakePoRepo()).execute(grnInput({ lines: undefined }), actor)).rejects.toThrow(
      'no open (unreceived) stock quantity',
    );
  });

  it('defaults from the PO open lines when only a PO is referenced', async () => {
    const grns = new FakeGrnRepo();
    const pos = new FakePoRepo();
    const poInput: NewPurchaseOrder = {
      projectId: PROJECT,
      supplierId: SUPPLIER,
      poRefNo: null,
      poDate: '2026-06-20',
      expectedDeliveryDate: null,
      lines: [{ itemId: 'item-cement', orderedQty: '50', rate: '500', godownId: 'g-a', projectId: PROJECT, costCentreId: 'cc', purposeId: 'pp' }],
    };
    pos.po = PurchaseOrder.createDraft('po-1', CO, FY, poInput, ['pol-1']);
    pos.po.approve('u1', CLOCK.now());
    await makeCreate(grns, new FakeBillRepo(), pos).execute(
      grnInput({ purchaseBillId: undefined, purchaseOrderId: 'po-1', lines: undefined }),
      actor,
    );
    expect(grns.grn!.lines[0].receivedQty.toFixed(4)).toBe('50.0000');
    expect(grns.grn!.lines[0].purchaseBillLineId).toBeNull();
  });

  it('rejects a GRN against a non-receivable (DRAFT) PO -> PO_NOT_BILLABLE (409)', async () => {
    const pos = new FakePoRepo();
    pos.po = PurchaseOrder.createDraft(
      'po-1',
      CO,
      FY,
      {
        projectId: PROJECT,
        supplierId: SUPPLIER,
        poRefNo: null,
        poDate: '2026-06-20',
        expectedDeliveryDate: null,
        lines: [{ itemId: 'item-cement', orderedQty: '10', rate: '500', godownId: 'g-a', projectId: PROJECT, costCentreId: 'cc', purposeId: 'pp' }],
      },
      ['pol-1'],
    );
    const bills = new FakeBillRepo();
    bills.bill = bill();
    await expect(
      makeCreate(new FakeGrnRepo(), bills, pos).execute(grnInput({ purchaseOrderId: 'po-1' }), actor),
    ).rejects.toBeInstanceOf(PoNotBillableError);
  });

  it('rejects a supplier/project mismatch with the referenced bill (SRS §11)', async () => {
    const bills = new FakeBillRepo();
    bills.bill = bill();
    await expect(
      makeCreate(new FakeGrnRepo(), bills, new FakePoRepo()).execute(grnInput({ supplierId: 'supp-OTHER' }), actor),
    ).rejects.toThrow('must match the referenced Purchase Bill');
  });

  it('rejects a purchaseBillLineId that is not a line of the referenced bill / wrong item', async () => {
    const bills = new FakeBillRepo();
    bills.bill = bill();
    await expect(
      makeCreate(new FakeGrnRepo(), bills, new FakePoRepo()).execute(
        grnInput({ lines: [{ ...grnInput().lines[0], purchaseBillLineId: 'bl-UNKNOWN' }] }),
        actor,
      ),
    ).rejects.toThrow('must reference a line of the referenced bill');
  });

  it('rejects a referenced bill that does not exist; and no lines + no refs to default from', async () => {
    await expect(makeCreate(new FakeGrnRepo(), new FakeBillRepo(), new FakePoRepo()).execute(grnInput(), actor)).rejects.toThrow(
      'not found',
    );
    await expect(
      makeCreate(new FakeGrnRepo(), new FakeBillRepo(), new FakePoRepo()).execute(
        grnInput({ purchaseBillId: undefined, lines: undefined }),
        actor,
      ),
    ).rejects.toThrow('requires lines');
  });

  it('PM scope: a project outside assignedProjectIds is FORBIDDEN (F4)', async () => {
    const pm: Actor = { ...actor, isUnscoped: false, assignedProjectIds: ['p-OTHER'] };
    const bills = new FakeBillRepo();
    bills.bill = bill();
    await expect(makeCreate(new FakeGrnRepo(), bills, new FakePoRepo()).execute(grnInput(), pm)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('PostGrnUseCase — THE §10 Q4 option-(a) invariant (FR-PUR-016/-017; AC1/AC4/AC5 in their N/A form)', () => {
  function makePost(grns: FakeGrnRepo, bills: FakeBillRepo): PostGrnUseCase {
    return new PostGrnUseCase(grns as never, bills as never, audit as never, uow as never, CLOCK as never);
  }
  function draftGrn(qty: string, billLineId: string | null = 'bl-1'): Grn {
    return Grn.createDraft(
      'grn-1',
      CO,
      FY,
      grnInput({ lines: [{ purchaseBillLineId: billLineId, itemId: 'item-cement', receivedQty: qty, rate: '500', godownId: 'g-a', costCentreId: 'cc', purposeId: 'pp' }] }),
      ['gl-1'],
    );
  }

  it('posts 90 against billed 100 -> UNDER_RECEIVED snapshot, POSTED, saved, audited — and performs ZERO inventory/ledger calls', async () => {
    const grns = new FakeGrnRepo();
    grns.grn = draftGrn('90');
    const bills = new FakeBillRepo();
    bills.bill = bill();

    const res = await makePost(grns, bills).execute('grn-1', actor);

    expect(res).toEqual({ id: 'grn-1', status: 'POSTED', lines: [{ lineNo: 1, matchStatus: 'UNDER_RECEIVED' }] });
    expect(grns.grn!.props.status).toBe('POSTED');
    expect(grns.grn!.lines[0].matchStatus).toBe('UNDER_RECEIVED');
    expect(grns.save).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'POST', entityType: 'Grn' }));

    // ── THE OPTION-(a) INVARIANT ── the use case has NO InventoryService/PostingService to call:
    expect(inventorySpy.receiveIn).not.toHaveBeenCalled();
    expect(inventorySpy.reverseReceipt).not.toHaveBeenCalled();
    expect(postingSpy.post).not.toHaveBeenCalled();
    expect(postingSpy.reverse).not.toHaveBeenCalled();
    // Compile-level guarantee: the constructor takes exactly (grns, bills, audit, uow, clock) — 5 deps.
    expect(PostGrnUseCase.length).toBe(5);
  });

  it('partial receipt 60 then 40: the second post sees receivedSoFar=60 -> 60+40=100 -> MATCHED (AC3)', async () => {
    const grns = new FakeGrnRepo();
    grns.grn = draftGrn('40');
    grns.receivedByBillLine.set('bl-1', d(60)); // an earlier POSTED GRN
    const bills = new FakeBillRepo();
    bills.bill = bill();
    const res = await makePost(grns, bills).execute('grn-1', actor);
    expect(res.lines[0].matchStatus).toBe('MATCHED');
  });

  it('over-delivery 110 of billed 100 -> OVER_RECEIVED, advisory — the post is NOT blocked (AC6)', async () => {
    const grns = new FakeGrnRepo();
    grns.grn = draftGrn('110');
    const bills = new FakeBillRepo();
    bills.bill = bill();
    const res = await makePost(grns, bills).execute('grn-1', actor);
    expect(res.status).toBe('POSTED');
    expect(res.lines[0].matchStatus).toBe('OVER_RECEIVED');
    expect(grns.grn!.props.status).toBe('POSTED');
  });

  it('a line with no bill-line reference compares against billed 0 -> OVER_RECEIVED (received, unbilled)', async () => {
    const grns = new FakeGrnRepo();
    grns.grn = draftGrn('10', null);
    const bills = new FakeBillRepo();
    bills.bill = bill();
    const res = await makePost(grns, bills).execute('grn-1', actor);
    expect(res.lines[0].matchStatus).toBe('OVER_RECEIVED');
    expect(grns.receivedSoFar).not.toHaveBeenCalled(); // nothing to sum without a bill-line ref
  });

  it('a bill-line ref whose bill/line cannot be resolved falls back to billed 0 (never crashes the post)', async () => {
    const grns = new FakeGrnRepo();
    const g = Grn.createDraft(
      'grn-1',
      CO,
      FY,
      grnInput({
        purchaseBillId: undefined, // PO-only header, yet the line carries a (stale) bill-line ref
        purchaseOrderId: undefined,
        lines: [{ purchaseBillLineId: 'bl-1', itemId: 'item-cement', receivedQty: '10', rate: '500', godownId: 'g-a', costCentreId: 'cc', purposeId: 'pp' }],
      }),
      ['gl-1'],
    );
    grns.grn = g;
    const res = await makePost(grns, new FakeBillRepo()).execute('grn-1', actor);
    expect(res.lines[0].matchStatus).toBe('OVER_RECEIVED'); // billed resolved to 0
  });

  it('DRAFT-only: posting an already-POSTED GRN -> VOUCHER_POSTED_IMMUTABLE (AC11); unknown id -> NOT_FOUND', async () => {
    const grns = new FakeGrnRepo();
    grns.grn = draftGrn('90');
    grns.grn.markPosted('u', CLOCK.now());
    const bills = new FakeBillRepo();
    bills.bill = bill();
    await expect(makePost(grns, bills).execute('grn-1', actor)).rejects.toMatchObject({ code: 'VOUCHER_POSTED_IMMUTABLE' });
    grns.grn = null;
    await expect(makePost(grns, bills).execute('grn-1', actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('CancelGrnUseCase — status flip ONLY under option (a)', () => {
  function makeCancel(grns: FakeGrnRepo): CancelGrnUseCase {
    return new CancelGrnUseCase(grns as never, audit as never, uow as never);
  }

  it('POSTED -> CANCELLED with an audit trail; NO reverseReceipt, NO posting.reverse', async () => {
    const grns = new FakeGrnRepo();
    const g = Grn.createDraft('grn-1', CO, FY, grnInput(), ['gl-1']);
    g.markPosted('u', CLOCK.now());
    grns.grn = g;

    const res = await makeCancel(grns).execute('grn-1', 'recorded against the wrong godown', actor);

    expect(res).toEqual({ id: 'grn-1', status: 'CANCELLED' });
    expect(grns.grn!.props.status).toBe('CANCELLED');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'CANCEL', entityType: 'Grn' }));
    expect(inventorySpy.reverseReceipt).not.toHaveBeenCalled();
    expect(postingSpy.reverse).not.toHaveBeenCalled();
    expect(CancelGrnUseCase.length).toBe(3); // (grns, audit, uow) — no INV/LED port exists to misuse
  });

  it('cancelling a DRAFT GRN -> VOUCHER_NOT_POSTED; unknown id -> NOT_FOUND', async () => {
    const grns = new FakeGrnRepo();
    grns.grn = Grn.createDraft('grn-1', CO, FY, grnInput(), ['gl-1']);
    await expect(makeCancel(grns).execute('grn-1', 'r', actor)).rejects.toMatchObject({ code: 'VOUCHER_NOT_POSTED' });
    grns.grn = null;
    await expect(makeCancel(grns).execute('grn-1', 'r', actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
