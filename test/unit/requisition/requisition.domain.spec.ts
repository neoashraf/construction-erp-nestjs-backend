/**
 * REQ Requisition aggregate unit tests (pure — no DB, no Nest). Cites FR-REQ-001/-004/-006/-008/-018/
 * -019/-020/-022. Covers: draft build (≥1 line, qty>0, issued=0/balance=requested); submit stamps
 * estimate/tier/no; approve/reject lifecycle (SUBMITTED-only + mandatory reject reason); partial-issue
 * balance arithmetic + carry-forward → PARTIALLY_ISSUED → ISSUED; over-issue rejection; reverse restores
 * balance; manual close abandons the balance vs NoOutstandingBalanceError on a fully-issued requisition;
 * DRAFT-only edit guard.
 */
import Decimal from 'decimal.js';
import { Requisition } from '../../../src/modules/requisition/domain/requisition';
import {
  IssueExceedsBalanceError,
  MissingRejectReasonError,
  NoOutstandingBalanceError,
  RequisitionNotDraftError,
  RequisitionNotSubmittedError,
} from '../../../src/modules/requisition/domain/errors';
import { ValidationError } from '../../../src/common/errors/domain-error';

const CO = 'co1';
const FY = 'fy1';
const PROJECT = 'p-01';
const AT = new Date('2026-07-01T10:00:00Z');
const d = (v: string) => new Decimal(v);

function draft(lines = [{ itemId: 'item-a', requestedQuantity: '80', uom: 'BAG' }]): Requisition {
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
      priority: 'HIGH',
      narration: null,
      lines,
    },
    lines.map((_, i) => `line-${i + 1}`),
  );
}

function submitted(): Requisition {
  const r = draft();
  r.submit('REQ-000001', 1, d('41600'), 'PM', [{ lineId: 'line-1', indicativeRate: d('520') }], 'u-req', AT);
  return r;
}

function approved(): Requisition {
  const r = submitted();
  r.approve(
    { id: 'a-1', decision: 'APPROVED', tier: 'PM', thresholdEvaluated: d('100000'), estimatedValue: d('41600'), reason: null, decidedBy: 'u-pm' },
    AT,
  );
  return r;
}

describe('Requisition.createDraft (FR-REQ-001/-004/-018)', () => {
  it('builds a DRAFT with issued=0 / balance=requested', () => {
    const r = draft();
    expect(r.props.status).toBe('DRAFT');
    expect(r.props.lines[0].issuedQuantity.toString()).toBe('0');
    expect(r.props.lines[0].balanceQuantity.toString()).toBe('80');
    expect(r.props.requisitionNo).toBeNull();
  });

  it('rejects zero lines', () => {
    expect(() => draft([])).toThrow(ValidationError);
  });

  it('rejects a non-positive requested quantity', () => {
    expect(() => draft([{ itemId: 'i', requestedQuantity: '0', uom: 'BAG' }])).toThrow(ValidationError);
  });
});

describe('Requisition.submit (FR-REQ-005/-006/-009)', () => {
  it('stamps estimate/tier/no + submittedAt/by → SUBMITTED', () => {
    const r = submitted();
    expect(r.props.status).toBe('SUBMITTED');
    expect(r.props.estimatedValue.toString()).toBe('41600');
    expect(r.props.approvalTier).toBe('PM');
    expect(r.props.requisitionNo).toBe('REQ-000001');
    expect(r.props.submittedById).toBe('u-req');
    expect(r.props.lines[0].indicativeRate?.toString()).toBe('520');
  });

  it('rejects edit after SUBMITTED (DRAFT-only — FR-REQ-022)', () => {
    const r = submitted();
    expect(() => r.editDraft({ priority: 'LOW' }, [])).toThrow(RequisitionNotDraftError);
  });
});

describe('Requisition.approve/reject (FR-REQ-008)', () => {
  it('approve moves SUBMITTED → APPROVED and records an approval', () => {
    const r = approved();
    expect(r.props.status).toBe('APPROVED');
    expect(r.approvals).toHaveLength(1);
    expect(r.approvals[0].props.decision).toBe('APPROVED');
  });

  it('reject requires a non-empty reason', () => {
    const r = submitted();
    expect(() =>
      r.reject(
        { id: 'a', decision: 'REJECTED', tier: 'PM', thresholdEvaluated: d('100000'), estimatedValue: d('41600'), reason: '  ', decidedBy: 'u' },
        AT,
      ),
    ).toThrow(MissingRejectReasonError);
  });

  it('reject with a reason moves SUBMITTED → REJECTED', () => {
    const r = submitted();
    r.reject(
      { id: 'a', decision: 'REJECTED', tier: 'PM', thresholdEvaluated: d('100000'), estimatedValue: d('41600'), reason: 'no budget', decidedBy: 'u' },
      AT,
    );
    expect(r.props.status).toBe('REJECTED');
    expect(r.approvals[0].props.reason).toBe('no budget');
  });

  it('approve/reject on a non-SUBMITTED requisition is rejected', () => {
    const r = draft();
    expect(() =>
      r.approve(
        { id: 'a', decision: 'APPROVED', tier: 'PM', thresholdEvaluated: d('100000'), estimatedValue: d('0'), reason: null, decidedBy: 'u' },
        AT,
      ),
    ).toThrow(RequisitionNotSubmittedError);
  });
});

describe('Requisition balance arithmetic (FR-REQ-018/-019, edge 2)', () => {
  it('partial issue carries the balance forward → PARTIALLY_ISSUED', () => {
    const r = approved();
    r.applyIssue([{ lineId: 'line-1', issueQuantity: d('50') }]);
    expect(r.props.lines[0].issuedQuantity.toString()).toBe('50');
    expect(r.props.lines[0].balanceQuantity.toString()).toBe('30');
    expect(r.props.status).toBe('PARTIALLY_ISSUED');
  });

  it('issuing the remaining balance → ISSUED', () => {
    const r = approved();
    r.applyIssue([{ lineId: 'line-1', issueQuantity: d('50') }]);
    r.applyIssue([{ lineId: 'line-1', issueQuantity: d('30') }]);
    expect(r.props.lines[0].balanceQuantity.toString()).toBe('0');
    expect(r.props.status).toBe('ISSUED');
  });

  it('rejects an issue exceeding the line balance', () => {
    const r = approved();
    expect(() => r.applyIssue([{ lineId: 'line-1', issueQuantity: d('90') }])).toThrow(IssueExceedsBalanceError);
  });

  it('reverse restores the line balance and reverts status', () => {
    const r = approved();
    r.applyIssue([{ lineId: 'line-1', issueQuantity: d('50') }]);
    r.reverseIssue([{ lineId: 'line-1', issuedQuantity: d('50') }]);
    expect(r.props.lines[0].issuedQuantity.toString()).toBe('0');
    expect(r.props.lines[0].balanceQuantity.toString()).toBe('80');
    expect(r.props.status).toBe('APPROVED');
  });
});

describe('Requisition.close (FR-REQ-020, edge 15)', () => {
  it('closes an APPROVED requisition with outstanding balance, abandoning the remainder', () => {
    const r = approved();
    r.close('site abandoned', AT);
    expect(r.props.status).toBe('CLOSED');
    expect(r.props.closedReason).toBe('site abandoned');
    expect(r.props.closedAt).toBe(AT);
  });

  it('rejects close of a fully-issued (ISSUED) requisition — NoOutstandingBalanceError', () => {
    const r = approved();
    r.applyIssue([{ lineId: 'line-1', issueQuantity: d('80') }]);
    expect(r.props.status).toBe('ISSUED');
    expect(() => r.close('too late', AT)).toThrow(NoOutstandingBalanceError);
  });
});
