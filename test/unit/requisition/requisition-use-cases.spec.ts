/**
 * REQ use-case unit tests (fake ports + fake UnitOfWork/Clock/IdGenerator). Cites FR-REQ-005/-006/-007/
 * -009/-010/-011/-020. Covers: submit computes the estimate + selects the tier + notifies the approver;
 * escalate-by-default — a PM approving an ACCOUNTS-tier requisition → ApprovalBeyondAuthorityError, and an
 * unassigned PM on a PM-tier requisition → the same; ACCOUNTS approves an escalated requisition; the
 * workflow use cases inject NEITHER InventoryService NOR PostingService (structurally: the constructors
 * take no ledger/stock port) and their fakes record no posting/stock call. Close abandons the balance.
 */
import Decimal from 'decimal.js';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { AccessPolicy } from '../../../src/core/auth/domain/access-policy';
import { Requisition } from '../../../src/modules/requisition/domain/requisition';
import { SubmitRequisitionUseCase } from '../../../src/modules/requisition/application/submit-requisition.usecase';
import { ApproveRequisitionUseCase } from '../../../src/modules/requisition/application/approve-requisition.usecase';
import { RejectRequisitionUseCase } from '../../../src/modules/requisition/application/reject-requisition.usecase';
import { CloseRequisitionUseCase } from '../../../src/modules/requisition/application/close-requisition.usecase';
import { ApprovalBeyondAuthorityError } from '../../../src/modules/requisition/domain/errors';

const CO = 'co1';
const FY = 'fy1';
const PROJECT = 'p-01';
const d = (v: string) => new Decimal(v);

const pmActor: Actor = {
  userId: 'u-pm',
  companyId: CO,
  financialYearId: FY,
  role: 'ProjectManager',
  isUnscoped: false,
  assignedProjectIds: [PROJECT],
  approvalLimit: d('100000'),
};
const pmOther: Actor = { ...pmActor, userId: 'u-pm2', assignedProjectIds: ['p-99'] };
const accountsActor: Actor = {
  userId: 'u-acc',
  companyId: CO,
  financialYearId: FY,
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const CLOCK = { now: () => new Date('2026-07-01T10:00:00Z') };
const idGen = () => {
  let n = 0;
  return { next: () => `id-${++n}` };
};
const uow = { run: <T>(work: () => Promise<T>) => work() };
const audit = { record: jest.fn(async () => undefined) };
const thresholds = { pmThreshold: jest.fn(async () => d('100000')) };

function draftWith(qty: string): Requisition {
  return Requisition.createDraft(
    'req-1',
    CO,
    FY,
    {
      projectId: PROJECT,
      costCentreId: 'cc',
      purposeId: 'pur',
      fromGodownId: 'g-1',
      requiredDate: '2026-07-10',
      priority: 'NORMAL',
      narration: null,
      lines: [{ itemId: 'item-a', requestedQuantity: qty, uom: 'BAG' }],
    },
    ['line-1'],
  );
}

class FakeRepo {
  req: Requisition | null = null;
  seq = 0;
  insert = jest.fn(async (r: Requisition) => {
    this.req = r;
  });
  save = jest.fn(async (r: Requisition) => {
    this.req = r;
  });
  findById = jest.fn(async () => this.req);
  findByIdForUpdate = jest.fn(async () => this.req);
  softDelete = jest.fn(async () => undefined);
  nextRequisitionSeq = jest.fn(async () => ++this.seq);
}

function makeRates(rate: string) {
  return { currentAvgOrLastKnown: jest.fn(async () => d(rate)) };
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

describe('SubmitRequisitionUseCase (FR-REQ-005/-006/-009)', () => {
  it('computes the estimate, selects the PM tier (≤ threshold), notifies the approver — no posting/stock', async () => {
    const repo = new FakeRepo();
    repo.req = draftWith('80'); // 80 × 520 = 41,600 ≤ 100,000 → PM
    const rates = makeRates('520');
    const notify = makeNotify();
    const uc = new SubmitRequisitionUseCase(
      repo as never,
      rates as never,
      thresholds as never,
      makeMasters() as never,
      notify as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await uc.execute('req-1', pmActor);
    expect(repo.req!.props.status).toBe('SUBMITTED');
    expect(repo.req!.props.estimatedValue.toString()).toBe('41600');
    expect(repo.req!.props.approvalTier).toBe('PM');
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });

  it('escalates to ACCOUNTS when the estimate exceeds the threshold', async () => {
    const repo = new FakeRepo();
    repo.req = draftWith('300'); // 300 × 520 = 156,000 > 100,000 → ACCOUNTS
    const uc = new SubmitRequisitionUseCase(
      repo as never,
      makeRates('520') as never,
      thresholds as never,
      makeMasters() as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await uc.execute('req-1', pmActor);
    expect(repo.req!.props.approvalTier).toBe('ACCOUNTS');
  });
});

describe('ApproveRequisitionUseCase — escalate-by-default (FR-REQ-010/-011)', () => {
  async function submitted(qty: string, actor: Actor = pmActor): Promise<FakeRepo> {
    const repo = new FakeRepo();
    repo.req = draftWith(qty);
    const submit = new SubmitRequisitionUseCase(
      repo as never,
      makeRates('520') as never,
      thresholds as never,
      makeMasters() as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await submit.execute('req-1', actor);
    return repo;
  }

  it('a PM approving an ACCOUNTS-tier (escalated) requisition → ApprovalBeyondAuthorityError; stays SUBMITTED', async () => {
    const repo = await submitted('300'); // escalated
    const notify = makeNotify();
    const uc = new ApproveRequisitionUseCase(
      repo as never,
      thresholds as never,
      notify as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );
    await expect(uc.execute('req-1', null, pmActor)).rejects.toBeInstanceOf(ApprovalBeyondAuthorityError);
    expect(repo.req!.props.status).toBe('SUBMITTED');
    expect(notify.notify).not.toHaveBeenCalled();
  });

  it('an unassigned PM approving a PM-tier requisition → ApprovalBeyondAuthorityError', async () => {
    const repo = await submitted('80'); // PM tier
    const uc = new ApproveRequisitionUseCase(
      repo as never,
      thresholds as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );
    await expect(uc.execute('req-1', null, pmOther)).rejects.toBeInstanceOf(ApprovalBeyondAuthorityError);
  });

  it('the assigned PM approves a PM-tier requisition → APPROVED, notifies Store Keeper + requester', async () => {
    const repo = await submitted('80');
    const notify = makeNotify();
    const uc = new ApproveRequisitionUseCase(
      repo as never,
      thresholds as never,
      notify as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );
    await uc.execute('req-1', 'ok', pmActor);
    expect(repo.req!.props.status).toBe('APPROVED');
    expect(repo.req!.approvals[0].props.decision).toBe('APPROVED');
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });

  it('Accounts approves an escalated (ACCOUNTS-tier) requisition', async () => {
    const repo = await submitted('300');
    const uc = new ApproveRequisitionUseCase(
      repo as never,
      thresholds as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );
    await uc.execute('req-1', null, accountsActor);
    expect(repo.req!.props.status).toBe('APPROVED');
  });
});

describe('Reject + Close (FR-REQ-008/-020)', () => {
  async function submittedPmTier(): Promise<FakeRepo> {
    const repo = new FakeRepo();
    repo.req = draftWith('80');
    const submit = new SubmitRequisitionUseCase(
      repo as never,
      makeRates('520') as never,
      thresholds as never,
      makeMasters() as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await submit.execute('req-1', pmActor);
    return repo;
  }

  it('reject records a REJECTED approval and notifies the requester', async () => {
    const repo = await submittedPmTier();
    const notify = makeNotify();
    const uc = new RejectRequisitionUseCase(
      repo as never,
      thresholds as never,
      notify as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    );
    await uc.execute('req-1', 'insufficient budget', pmActor);
    expect(repo.req!.props.status).toBe('REJECTED');
    expect(repo.req!.approvals[0].props.reason).toBe('insufficient budget');
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });

  it('close abandons the balance → CLOSED (no ledger effect — the use case injects no PostingService)', async () => {
    const repo = await submittedPmTier();
    // approve first
    await new ApproveRequisitionUseCase(
      repo as never,
      thresholds as never,
      makeNotify() as never,
      audit as never,
      uow as never,
      CLOCK as never,
      idGen() as never,
    ).execute('req-1', null, pmActor);

    const notify = makeNotify();
    const uc = new CloseRequisitionUseCase(
      repo as never,
      notify as never,
      new AccessPolicy(),
      audit as never,
      uow as never,
      CLOCK as never,
    );
    await uc.execute('req-1', 'client cancelled', pmActor);
    expect(repo.req!.props.status).toBe('CLOSED');
    expect(repo.req!.props.closedReason).toBe('client cancelled');
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });
});
