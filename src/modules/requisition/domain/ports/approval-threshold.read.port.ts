/**
 * ApprovalThresholdReadPort (driven; owner MAS/company config). The configurable BDT PM-tier threshold:
 * an estimated value at or below it → PM tier, above → escalate to ACCOUNTS (FR-REQ-009). The value is
 * company configuration (pending client; escalate-by-default applies until set — overview §10). This brief
 * READS it via the port; it does not build the config screen. PURE interface.
 */
import Decimal from 'decimal.js';

export interface ApprovalThresholdReadPort {
  pmThreshold(companyId: string): Promise<Decimal>;
}

export const APPROVAL_THRESHOLD_READ_PORT = Symbol('ApprovalThresholdReadPort');
