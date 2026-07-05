/**
 * Notification Type Catalogue (NTF domain — FR-NTF-021, SRS 18 Appendix A). PURE TypeScript.
 *
 * The enumerated notification types, each with its owning source module, default severity, and a
 * recipient RULE (how `NotificationService.emit` resolves who receives it):
 *   - ROLE(roles)         → all active holders of the role(s), company-wide (unscoped delivery).
 *   - PROJECT_ROLE(roles) → active holders of the role(s) ASSIGNED to the event's project.
 *   - USER                → the affected user (from command.affectedUserId).
 * This static list is the single source of truth for emit-time validation; an out-of-catalogue type is
 * rejected. Roles are the six seeded built-in names.
 */

export type Severity = 'HIGH' | 'NORMAL' | 'LOW';

export type RecipientRule =
  | { kind: 'ROLE'; roles: string[] }
  | { kind: 'PROJECT_ROLE'; roles: string[] }
  | { kind: 'USER' };

export interface NotificationTypeDef {
  readonly code: string;
  readonly sourceModule: string;
  readonly severity: Severity;
  readonly recipients: readonly RecipientRule[];
}

const ROLE = (...roles: string[]): RecipientRule => ({ kind: 'ROLE', roles });
const PROJECT_ROLE = (...roles: string[]): RecipientRule => ({ kind: 'PROJECT_ROLE', roles });
const USER: RecipientRule = { kind: 'USER' };

const ADMIN = 'ADMIN';
const PM = 'PROJECT_MANAGER';
const SE = 'SITE_ENGINEER';
const SK = 'STORE_KEEPER';
const AM = 'ACCOUNTS_MANAGER';
const HR = 'HR_MANAGER';
const ALL_POSTING = [AM, ADMIN, PM, SE, SK, HR];

function def(code: string, sourceModule: string, severity: Severity, recipients: RecipientRule[]): NotificationTypeDef {
  return { code, sourceModule, severity, recipients };
}

/** The catalogue (SRS 18 Appendix A). */
export const NOTIFICATION_TYPES: readonly NotificationTypeDef[] = [
  // A.1 Approvals & workflow — REQ / PUR / INV
  def('REQ_SUBMITTED', 'REQ', 'HIGH', [PROJECT_ROLE(PM), ROLE(AM)]),
  def('REQ_ESCALATED', 'REQ', 'HIGH', [ROLE(AM)]),
  def('REQ_APPROVED', 'REQ', 'NORMAL', [USER, PROJECT_ROLE(SK)]),
  def('REQ_REJECTED', 'REQ', 'NORMAL', [USER]),
  def('REQ_ISSUED', 'REQ', 'NORMAL', [USER]),
  def('REQ_PARTIALLY_ISSUED', 'REQ', 'NORMAL', [USER, PROJECT_ROLE(PM)]),
  def('REQ_CLOSED', 'REQ', 'LOW', [USER]),
  def('PO_SUBMITTED', 'PUR', 'NORMAL', [ROLE(AM, ADMIN)]),
  def('PO_APPROVED', 'PUR', 'NORMAL', [USER, PROJECT_ROLE(SK)]),
  def('PO_CANCELLED', 'PUR', 'LOW', [USER, ROLE(AM)]),
  def('PURCHASE_BILL_POSTED', 'PUR', 'LOW', [ROLE(AM)]),
  def('GRN_POSTED', 'PUR', 'NORMAL', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('GRN_MISMATCH', 'PUR', 'HIGH', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('PURCHASE_BILL_REVERSED', 'PUR', 'NORMAL', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('STOCK_JOURNAL_SUBMITTED', 'INV', 'NORMAL', [PROJECT_ROLE(PM)]),
  def('STOCK_JOURNAL_APPROVED', 'INV', 'NORMAL', [USER]),
  def('STOCK_JOURNAL_POSTED', 'INV', 'NORMAL', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('STOCK_JOURNAL_REVERSED', 'INV', 'NORMAL', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('NEGATIVE_STOCK_AUTHORISED', 'INV', 'HIGH', [ROLE(AM, ADMIN), PROJECT_ROLE(PM)]),

  // A.2 Financial AR / AP — SAL / REC / PAY
  def('IPC_POSTED', 'SAL', 'NORMAL', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('IPC_OVERDUE', 'SAL', 'HIGH', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('IPC_FULLY_SETTLED', 'SAL', 'NORMAL', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('RETENTION_DUE', 'SAL', 'NORMAL', [ROLE(AM)]),
  def('RETENTION_RELEASED', 'SAL', 'NORMAL', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('ADVANCE_FULLY_RECOVERED', 'SAL', 'LOW', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('IPC_REVERSED', 'SAL', 'NORMAL', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('RECEIPT_POSTED', 'REC', 'NORMAL', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('RECEIPT_REVERSED', 'REC', 'NORMAL', [ROLE(AM), PROJECT_ROLE(PM)]),
  def('PAYMENT_POSTED', 'PAY', 'NORMAL', [ROLE(AM)]),
  def('PAYABLE_SETTLED', 'PAY', 'NORMAL', [ROLE(AM)]),
  def('PAYABLE_OVERDUE', 'PAY', 'HIGH', [ROLE(AM)]),
  def('PAYMENT_REVERSED', 'PAY', 'NORMAL', [ROLE(AM)]),

  // A.3 Budget & cost — CC
  def('BUDGET_OVER', 'CC', 'HIGH', [PROJECT_ROLE(PM), ROLE(AM, ADMIN)]),
  def('BUDGET_APPROACHING', 'CC', 'NORMAL', [PROJECT_ROLE(PM)]),

  // A.4 Period control — PER
  def('PERIOD_CLOSING_SOON', 'PER', 'NORMAL', [ROLE(...ALL_POSTING)]),
  def('PERIOD_CLOSED', 'PER', 'HIGH', [ROLE(...ALL_POSTING)]),
  def('PERIOD_REOPENED', 'PER', 'NORMAL', [ROLE(AM, ADMIN)]),

  // A.5 HR & payroll — HR
  def('ATTENDANCE_SUBMITTED', 'HR', 'NORMAL', [ROLE(HR, AM)]),
  def('DAILY_LABOUR_ACCRUED', 'HR', 'NORMAL', [ROLE(HR, AM)]),
  def('SALARY_POSTED', 'HR', 'NORMAL', [ROLE(HR, AM)]),
  def('SALARY_REVERSED', 'HR', 'NORMAL', [ROLE(HR, AM)]),
  def('PAYSLIP_AVAILABLE', 'HR', 'NORMAL', [USER]),

  // A.6 Security & system — AUD
  def('ACCOUNT_LOCKED_OUT', 'AUD', 'HIGH', [USER, ROLE(ADMIN)]),
  def('PASSWORD_RESET_FORCED', 'AUD', 'HIGH', [USER]),
  def('USER_CREATED_WELCOME', 'AUD', 'NORMAL', [USER]),
  def('USER_DEACTIVATED', 'AUD', 'HIGH', [USER, ROLE(ADMIN)]),
  def('ROLE_PERMISSIONS_CHANGED', 'AUD', 'NORMAL', [USER]),
  def('USER_PROJECT_ASSIGNMENT_CHANGED', 'AUD', 'LOW', [USER]),
  def('SENSITIVE_AUTH_DENIED', 'AUD', 'HIGH', [ROLE(ADMIN)]),
  def('APPROVAL_OVER_LIMIT_ESCALATION', 'AUD', 'HIGH', [ROLE(ADMIN)]),
  def('REFRESH_TOKEN_REUSE_DETECTED', 'AUD', 'HIGH', [USER, ROLE(ADMIN)]),
];

const BY_CODE: ReadonlyMap<string, NotificationTypeDef> = new Map(NOTIFICATION_TYPES.map(t => [t.code, t]));

export function isValidNotificationType(code: string): boolean {
  return BY_CODE.has(code);
}

/** The catalogue entry for `code`, or undefined if not a catalogue type. */
export function getNotificationType(code: string): NotificationTypeDef | undefined {
  return BY_CODE.get(code);
}
