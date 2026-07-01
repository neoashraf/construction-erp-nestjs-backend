/**
 * PostingCommand / PostingLine — framework-neutral request types (PURE). Each voucher module builds a
 * balanced, fully-tagged command and submits it to PostingService.post(cmd) (FR-LED-003). The four
 * posting dimensions + party are per-line; `accountType`/`isControlAccount` are classification hints the
 * voucher module supplies (from MAS) so the TagMatrix can apply the §5.1 rules without an async lookup.
 */
import { Money } from '../../../common/money';
import { VoucherType } from './voucher-type';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export interface PostingLine {
  accountId: string;
  projectId?: string;
  costCentreId?: string;
  purposeId?: string;
  godownId?: string;
  partyId?: string;
  debit: Money;
  credit: Money;
  narration?: string;
  /** Account classification hints (supplied by the voucher module from MAS) for tag-matrix policy. */
  accountType?: AccountType;
  isControlAccount?: boolean;
  /**
   * PURCHASE-only hint (purchase-po-bill-posting, decision 5): true on an inventory-debit line (requires
   * godown), false/omitted on the bill's non-inventory lines (AP/VAT-input/TDS/AIT — no godown). Ignored
   * by every other voucher type's tag-matrix rule.
   */
  isStockLine?: boolean;
}

export interface PostingCommand {
  companyId: string;
  financialYearId: string;
  voucherType: VoucherType;
  voucherDate: string; // 'YYYY-MM-DD'
  sourceType: string;
  sourceId: string;
  postedBy: string;
  narration?: string;
  lines: PostingLine[];
}
