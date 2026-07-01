/**
 * ReceiptAccountMapPort — driven port (MAS: resolve Accounts Receivable + the tax-deducted-at-source
 * recoverable account for the company). `generalTargetFacts` classifies a client-supplied
 * `generalTargetAccountId` (INCOME vs the advance-from-customer liability control account) so
 * `buildReceiptCommand` can decide whether the credit line is party-tagged (FR-REC-010, FR-REC-011).
 */
import { GeneralTargetAccountFacts, ReceiptAccountMap } from '../receipt-posting';

export interface ReceiptAccountMapPort {
  resolve(companyId: string): Promise<ReceiptAccountMap>;
  /** Classify the general receipt's target account; null if not found / not a valid target. */
  generalTargetFacts(companyId: string, accountId: string): Promise<GeneralTargetAccountFacts | null>;
}

export const RECEIPT_ACCOUNT_MAP_PORT = Symbol('ReceiptAccountMapPort');
