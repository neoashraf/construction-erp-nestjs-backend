/**
 * REQ issue use-case unit tests (fake INV/LED ports + fake UnitOfWork/Clock/IdGenerator). Cites
 * FR-REQ-012..019. Covers: issueOut called once per line, one posting.post call, atomic rollback on a
 * forced posting failure (nothing persisted), ISSUE_EXCEEDS_BALANCE / REQUISITION_NOT_APPROVED /
 * GODOWN_NOT_IN_PROJECT guards, multi-item balanced-overall command, partial issue carries the balance
 * forward, and reversal restores balances + calls reverseIssueOut + posting.reverse.
 */
import Decimal from 'decimal.js';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { Requisition } from '../../../src/modules/requisition/domain/requisition';
import { RequisitionIssue } from '../../../src/modules/requisition/domain/requisition-issue';
import { IssueRequisitionUseCase } from '../../../src/modules/requisition/application/issue-requisition.usecase';
import { ReverseIssueUseCase } from '../../../src/modules/requisition/application/reverse-issue.usecase';
import {
  IssueExceedsBalanceError,
  RequisitionNotApprovedError,
} from '../../../src/modules/requisition/domain/errors';
import { GodownNotInProjectError, NotFoundError } from '../../../src/common/errors/domain-error';
import { PostingCommand, PostingLine } from '../../../src/core/posting/domain/posting-command';

function sumDebit(lines: PostingLine[]): Decimal {
  return lines.reduce((s, l) => s.plus(l.debit.amount), new Decimal(0));
}
function sumCredit(lines: PostingLine[]): Decimal {
  return lines.reduce((s, l) => s.plus(l.credit.amount), new Decimal(0));
}

const CO = 'co1';
const FY = 'fy1';
const PROJECT = 'p-01';
const GODOWN = 'g-1';
const CC = 'cc';
const PURPOSE = 'pur';
const d = (v: string) => new Decimal(v);

const storeKeeperActor: Actor = {
  userId: 'u-sk',
  companyId: CO,
  financialYearId: FY,
  role: 'StoreKeeper',
  isUnscoped: false,
  assignedProjectIds: [PROJECT],
  approvalLimit: null,
};

const CLOCK = { now: () => new Date('2026-07-01T10:00:00Z') };
function idGen() {
  let n = 0;
  return { next: () => `id-${++n}` };
}
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };

function draftWith(qty: string): Requisition {
  return Requisition.createDraft(
    'req-1',
    CO,
    FY,
    {
      projectId: PROJECT,
      costCentreId: CC,
      purposeId: PURPOSE,
      fromGodownId: GODOWN,
      requiredDate: '2026-07-10',
      priority: 'NORMAL',
      narration: null,
      lines: [{ itemId: 'item-a', requestedQuantity: qty, uom: 'BAG' }],
    },
    ['line-1'],
  );
}

function multiLineDraft(): Requisition {
  return Requisition.createDraft(
    'req-1',
    CO,
    FY,
    {
      projectId: PROJECT,
      costCentreId: CC,
      purposeId: PURPOSE,
      fromGodownId: GODOWN,
      requiredDate: '2026-07-10',
      priority: 'NORMAL',
      narration: null,
      lines: [
        { itemId: 'item-cement', requestedQuantity: '50', uom: 'BAG' },
        { itemId: 'item-steel', requestedQuantity: '200', uom: 'KG' },
      ],
    },
    ['line-1', 'line-2'],
  );
}

function approvedFrom(r: Requisition): Requisition {
  r.submit('REQ-000001', 1, d('41600'), 'PM', [], 'u-req', CLOCK.now());
  r.approve(
    { id: 'a-1', decision: 'APPROVED', tier: 'PM', thresholdEvaluated: d('100000'), estimatedValue: d('41600'), reason: null, decidedBy: 'u-pm' },
    CLOCK.now(),
  );
  return r;
}

class FakeRepo {
  req: Requisition | null = null;
  savedIssues: RequisitionIssue[] = [];
  reversedIssues: RequisitionIssue[] = [];
  lineBalances = new Map<string, { requisitionId: string; itemId: string; balanceQuantity: Decimal }>();
  issueNoSeq = 0;

  insert = jest.fn(async (r: Requisition) => {
    this.req = r;
  });
  save = jest.fn(async (r: Requisition) => {
    this.req = r;
  });
  findById = jest.fn(async () => this.req);
  findByIdForUpdate = jest.fn(async () => this.req);
  softDelete = jest.fn(async () => undefined);
  nextRequisitionSeq = jest.fn(async () => 1);

  findLineForUpdate = jest.fn(async (lineId: string) => {
    const line = this.req?.props.lines.find((l) => l.id === lineId);
    if (!line || !this.req) return null;
    return {
      id: line.id,
      requisitionId: this.req.id,
      itemId: line.itemId,
      balanceQuantity: line.balanceQuantity,
    };
  });
  saveIssue = jest.fn(async (issue: RequisitionIssue) => {
    this.savedIssues.push(issue);
  });
  saveIssueReversal = jest.fn(async (issue: RequisitionIssue) => {
    this.reversedIssues.push(issue);
  });
  findIssue = jest.fn(async (_reqId: string, issueId: string) =>
    this.savedIssues.find((i) => i.id === issueId) ?? null,
  );
  listIssues = jest.fn(async () => this.savedIssues);
  nextIssueNo = jest.fn(async () => ++this.issueNoSeq);
}

function makeInventory(rate = '520') {
  let seq = 0;
  return {
    receiveIn: jest.fn(),
    issueOut: jest.fn(async (_ctx: unknown, input: { qty: Decimal }) => ({
      issuedValue: input.qty.times(rate),
      rate: d(rate),
      movementId: `mv-${++seq}`,
    })),
    reverseIssueOut: jest.fn(async () => undefined),
  };
}

function makeAccounts() {
  return {
    inventoryAccountOf: jest.fn(async () => 'acct-inventory'),
    expenseAccountOf: jest.fn(async () => 'acct-expense'),
  };
}

function makeMasters() {
  return {
    assertProjectNotClosed: jest.fn(async () => undefined),
    assertCostCentreActive: jest.fn(async () => undefined),
    assertGodownActiveInProject: jest.fn(async () => undefined),
    itemBaseUom: jest.fn(async () => 'BAG'),
  };
}

function makeNotify() {
  return { notify: jest.fn(async () => undefined) };
}

function makePosting(entryId = 'entry-1', entryNo = 'SJ/2526/0001') {
  return {
    post: jest.fn(async (cmd: PostingCommand) => ({
      id: entryId,
      props: { entryNo, lines: cmd.lines },
    })),
    reverse: jest.fn(async () => ({ id: 'reversal-1', props: { entryNo: 'SJ/2526/0002' } })),
  };
}

describe('IssueRequisitionUseCase (FR-REQ-012..019)', () => {
  it('issues a single line: issueOut called once, posting.post called once, balanced Dr expense/Cr inventory, four dims', async () => {
    const repo = new FakeRepo();
    repo.req = approvedFrom(draftWith('80'));
    const inventory = makeInventory('520');
    const accounts = makeAccounts();
    const posting = makePosting();
    const uc = new IssueRequisitionUseCase(
      repo as never,
      inventory as never,
      accounts as never,
      makeMasters() as never,
      posting as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );

    const result = await uc.execute(
      'req-1',
      { fromGodownId: GODOWN, lines: [{ requisitionLineId: 'line-1', issueQuantity: '50' }] },
      storeKeeperActor,
    );

    expect(inventory.issueOut).toHaveBeenCalledTimes(1);
    expect(posting.post).toHaveBeenCalledTimes(1);
    const cmd: PostingCommand = posting.post.mock.calls[0][0];
    expect(cmd.lines).toHaveLength(2);
    const dr = sumDebit(cmd.lines);
    const cr = sumCredit(cmd.lines);
    expect(dr.toFixed(4)).toBe(cr.toFixed(4));
    expect(dr.toFixed(4)).toBe('26000.0000');
    for (const l of cmd.lines) {
      expect(l.projectId).toBe(PROJECT);
      expect(l.costCentreId).toBe(CC);
      expect(l.purposeId).toBe(PURPOSE);
      expect(l.godownId).toBe(GODOWN);
    }
    expect(result.requisitionStatus).toBe('PARTIALLY_ISSUED');
    expect(repo.req!.props.lines[0].balanceQuantity.toString()).toBe('30');
    expect(repo.savedIssues).toHaveLength(1);
  });

  it('multi-item issue posts ONE balanced entry (expense/inventory pair per item), one posting.post call', async () => {
    const repo = new FakeRepo();
    repo.req = approvedFrom(multiLineDraft());
    const inventory = makeInventory('520');
    const posting = makePosting();
    const uc = new IssueRequisitionUseCase(
      repo as never,
      inventory as never,
      makeAccounts() as never,
      makeMasters() as never,
      posting as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );

    await uc.execute(
      'req-1',
      {
        fromGodownId: GODOWN,
        lines: [
          { requisitionLineId: 'line-1', issueQuantity: '50' },
          { requisitionLineId: 'line-2', issueQuantity: '200' },
        ],
      },
      storeKeeperActor,
    );

    expect(inventory.issueOut).toHaveBeenCalledTimes(2);
    expect(posting.post).toHaveBeenCalledTimes(1);
    const cmd: PostingCommand = posting.post.mock.calls[0][0];
    expect(cmd.lines).toHaveLength(4); // 2 items × (expense + inventory)
    const dr = sumDebit(cmd.lines);
    const cr = sumCredit(cmd.lines);
    expect(dr.toFixed(4)).toBe(cr.toFixed(4));
    expect(repo.savedIssues[0].lines).toHaveLength(2);
  });

  it('rejects an issue exceeding the line balance — ISSUE_EXCEEDS_BALANCE', async () => {
    const repo = new FakeRepo();
    repo.req = approvedFrom(draftWith('80'));
    const uc = new IssueRequisitionUseCase(
      repo as never,
      makeInventory() as never,
      makeAccounts() as never,
      makeMasters() as never,
      makePosting() as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );
    await expect(
      uc.execute(
        'req-1',
        { fromGodownId: GODOWN, lines: [{ requisitionLineId: 'line-1', issueQuantity: '90' }] },
        storeKeeperActor,
      ),
    ).rejects.toBeInstanceOf(IssueExceedsBalanceError);
  });

  it('rejects issue on a non-APPROVED/PARTIALLY_ISSUED requisition — REQUISITION_NOT_APPROVED', async () => {
    const repo = new FakeRepo();
    repo.req = draftWith('80'); // still DRAFT
    const uc = new IssueRequisitionUseCase(
      repo as never,
      makeInventory() as never,
      makeAccounts() as never,
      makeMasters() as never,
      makePosting() as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );
    await expect(
      uc.execute(
        'req-1',
        { fromGodownId: GODOWN, lines: [{ requisitionLineId: 'line-1', issueQuantity: '10' }] },
        storeKeeperActor,
      ),
    ).rejects.toBeInstanceOf(RequisitionNotApprovedError);
  });

  it('rejects a source godown outside the requisition project — GODOWN_NOT_IN_PROJECT', async () => {
    const repo = new FakeRepo();
    repo.req = approvedFrom(draftWith('80'));
    const masters = makeMasters();
    masters.assertGodownActiveInProject = jest.fn(async () => {
      throw new GodownNotInProjectError('g-other', PROJECT);
    });
    const uc = new IssueRequisitionUseCase(
      repo as never,
      makeInventory() as never,
      makeAccounts() as never,
      masters as never,
      makePosting() as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );
    await expect(
      uc.execute(
        'req-1',
        { fromGodownId: 'g-other', lines: [{ requisitionLineId: 'line-1', issueQuantity: '10' }] },
        storeKeeperActor,
      ),
    ).rejects.toBeInstanceOf(GodownNotInProjectError);
  });

  it('atomic: a forced posting failure rolls back — repo.save/saveIssue never persist a partial result', async () => {
    const repo = new FakeRepo();
    repo.req = approvedFrom(draftWith('80'));
    const posting = makePosting();
    posting.post.mockRejectedValueOnce(new Error('forced posting failure'));
    const failingUow = {
      run: async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          return await work();
        } catch (e) {
          // Simulate rollback: undo any writes recorded before the throw.
          repo.savedIssues = [];
          throw e;
        }
      },
    };
    const uc = new IssueRequisitionUseCase(
      repo as never,
      makeInventory() as never,
      makeAccounts() as never,
      makeMasters() as never,
      posting as never,
      makeNotify() as never,
      audit as never,
      failingUow as never,
      CLOCK as never,
      idGen() as never,
    );
    await expect(
      uc.execute(
        'req-1',
        { fromGodownId: GODOWN, lines: [{ requisitionLineId: 'line-1', issueQuantity: '50' }] },
        storeKeeperActor,
      ),
    ).rejects.toThrow('forced posting failure');
    expect(repo.savedIssues).toHaveLength(0);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('partial issue carries the balance forward; a follow-up issue completes it → ISSUED', async () => {
    const repo = new FakeRepo();
    repo.req = approvedFrom(draftWith('80'));
    const inventory = makeInventory('520');
    const uc = new IssueRequisitionUseCase(
      repo as never,
      inventory as never,
      makeAccounts() as never,
      makeMasters() as never,
      makePosting() as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );

    const first = await uc.execute(
      'req-1',
      { fromGodownId: GODOWN, lines: [{ requisitionLineId: 'line-1', issueQuantity: '50' }] },
      storeKeeperActor,
    );
    expect(first.requisitionStatus).toBe('PARTIALLY_ISSUED');
    expect(repo.req!.props.lines[0].balanceQuantity.toString()).toBe('30');

    const second = await uc.execute(
      'req-1',
      { fromGodownId: GODOWN, lines: [{ requisitionLineId: 'line-1', issueQuantity: '30' }] },
      storeKeeperActor,
    );
    expect(second.requisitionStatus).toBe('ISSUED');
    expect(repo.req!.props.lines[0].balanceQuantity.toString()).toBe('0');
    expect(repo.savedIssues).toHaveLength(2);
  });
});

describe('ReverseIssueUseCase (FR-REQ-017, edge 12)', () => {
  async function issuedRepo(): Promise<{ repo: FakeRepo; inventory: ReturnType<typeof makeInventory>; posting: ReturnType<typeof makePosting> }> {
    const repo = new FakeRepo();
    repo.req = approvedFrom(draftWith('80'));
    const inventory = makeInventory('520');
    const posting = makePosting();
    const issueUc = new IssueRequisitionUseCase(
      repo as never,
      inventory as never,
      makeAccounts() as never,
      makeMasters() as never,
      posting as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );
    await issueUc.execute(
      'req-1',
      { fromGodownId: GODOWN, lines: [{ requisitionLineId: 'line-1', issueQuantity: '50' }] },
      storeKeeperActor,
    );
    return { repo, inventory, posting };
  }

  it('reverses a posted issue: restores balances, calls reverseIssueOut + posting.reverse', async () => {
    const { repo, inventory, posting } = await issuedRepo();
    const issueId = repo.savedIssues[0].id;
    const uc = new ReverseIssueUseCase(
      repo as never,
      inventory as never,
      posting as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );

    const result = await uc.execute('req-1', issueId, 'wrong issue', storeKeeperActor);

    expect(inventory.reverseIssueOut).toHaveBeenCalledTimes(1);
    expect(posting.reverse).toHaveBeenCalledTimes(1);
    expect(result.requisitionStatus).toBe('APPROVED');
    expect(repo.req!.props.lines[0].issuedQuantity.toString()).toBe('0');
    expect(repo.req!.props.lines[0].balanceQuantity.toString()).toBe('80');
    expect(repo.reversedIssues).toHaveLength(1);
  });

  it('a second reverse on the same issue → ALREADY_REVERSED', async () => {
    const { repo, inventory, posting } = await issuedRepo();
    const issueId = repo.savedIssues[0].id;
    const uc = new ReverseIssueUseCase(
      repo as never,
      inventory as never,
      posting as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await uc.execute('req-1', issueId, 'first reverse', storeKeeperActor);
    await expect(uc.execute('req-1', issueId, 'second reverse', storeKeeperActor)).rejects.toMatchObject({
      code: 'ALREADY_REVERSED',
    });
  });

  it('reversing an unknown issue id -> NotFoundError', async () => {
    const { repo, inventory, posting } = await issuedRepo();
    const uc = new ReverseIssueUseCase(
      repo as never,
      inventory as never,
      posting as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await expect(uc.execute('req-1', 'unknown-issue', 'reason', storeKeeperActor)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
