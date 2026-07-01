/**
 * REQ approval-policy unit tests (pure — no DB, no Nest). Cites FR-REQ-009/-010/-011. Covers tier
 * selection (at-or-below → PM, above → escalate, exact-boundary → PM) and escalate-by-default authority
 * (a PM can never approve an ACCOUNTS-tier requisition; an unassigned PM is rejected; an ACCOUNTS
 * approver approves an escalated requisition).
 */
import Decimal from 'decimal.js';
import { canApprove, selectTier } from '../../../src/modules/requisition/domain/approval-policy';

const d = (v: string) => new Decimal(v);

describe('REQ approval-policy.selectTier (FR-REQ-009)', () => {
  it('at or below the threshold → PM', () => {
    expect(selectTier(d('50000'), d('100000'))).toBe('PM');
  });

  it('above the threshold → escalate to ACCOUNTS', () => {
    expect(selectTier(d('150000'), d('100000'))).toBe('ACCOUNTS');
  });

  it('exactly at the threshold → PM (at-or-below)', () => {
    expect(selectTier(d('100000'), d('100000'))).toBe('PM');
  });

  it('is exact decimal (no float drift near the boundary)', () => {
    expect(selectTier(d('100000.0001'), d('100000'))).toBe('ACCOUNTS');
    expect(selectTier(d('99999.9999'), d('100000'))).toBe('PM');
  });
});

describe('REQ approval-policy.canApprove — escalate-by-default (FR-REQ-010/-011)', () => {
  it('a PM approves a PM-tier requisition for an assigned project', () => {
    expect(canApprove('PM', { tier: 'PM', assignedToProject: true })).toBe(true);
  });

  it('a PM cannot approve a PM-tier requisition for an unassigned project', () => {
    expect(canApprove('PM', { tier: 'PM', assignedToProject: false })).toBe(false);
  });

  it('a PM can NEVER approve an ACCOUNTS-tier (escalated) requisition', () => {
    expect(canApprove('ACCOUNTS', { tier: 'PM', assignedToProject: true })).toBe(false);
  });

  it('an ACCOUNTS approver approves an ACCOUNTS-tier requisition', () => {
    expect(canApprove('ACCOUNTS', { tier: 'ACCOUNTS', assignedToProject: true })).toBe(true);
  });

  it('an ACCOUNTS approver is not required to be on the project', () => {
    expect(canApprove('ACCOUNTS', { tier: 'ACCOUNTS', assignedToProject: false })).toBe(true);
  });
});
