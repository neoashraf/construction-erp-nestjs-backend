/**
 * ApprovalThresholdAdapter (INFRASTRUCTURE) — implements ApprovalThresholdReadPort. Phase-1: the company
 * PM-tier BDT threshold is pending client (overview §10), and MAS exposes no approval-config table yet,
 * so this returns a config default (held as a constant, NOT hard-coded in the policy). When MAS/company
 * config lands an approval-threshold field, rebind this adapter to read it; the port + the pure
 * approval-policy stay unchanged. Escalate-by-default applies regardless (FR-REQ-009/-010).
 */
import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { ApprovalThresholdReadPort } from '../domain/ports/approval-threshold.read.port';

/** Pending-client default PM-tier threshold (BDT). At or below → PM; above → escalate to ACCOUNTS. */
export const DEFAULT_PM_THRESHOLD = '100000';

@Injectable()
export class ApprovalThresholdAdapter implements ApprovalThresholdReadPort {
  async pmThreshold(_companyId: string): Promise<Decimal> {
    void _companyId;
    const configured = process.env.REQ_PM_APPROVAL_THRESHOLD;
    return new Decimal(configured && configured.trim() ? configured : DEFAULT_PM_THRESHOLD);
  }
}
