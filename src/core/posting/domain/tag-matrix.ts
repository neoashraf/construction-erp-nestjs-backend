/**
 * TagMatrix — LED domain service (PURE) mirroring the canonical tag-requirement matrix (overview §5.1).
 * `assert(cmd)` rejects any line missing a dimension REQUIRED for its voucher type, and any AR/AP
 * control-account line missing a party (FR-LED-010..012). Optional dimensions are accepted, not required.
 *
 * For JOURNAL / CONTRA / OPENING / PAYMENT the requirement is per-line by account type: a P&L line
 * (INCOME/EXPENSE) needs project+cost_centre+purpose; a balance-sheet line is optional. CONTRA lines are
 * optional. The party rule is keyed on the account being a control account, regardless of voucher type
 * (design §10 item 3). RECEIPT requires cost_centre+purpose; project is supplied by the REC module for
 * IPC-linked receipts (it knows the IPC link) — LED enforces what it can see on the command.
 *
 * PAYMENT (payment-voucher-core #27) is per-line by account type, like JOURNAL/OPENING: a payment SETTLES
 * a payable (Dr LIABILITY control) and pays cash (Cr ASSET) — those balance-sheet lines carry NO dimensions
 * and (potentially) settle payables spanning many projects; only the payment's own P&L lines — the optional
 * bank-charge (EXPENSE) and the daily-labour accrued-vs-paid true-up (EXPENSE) — require project+cost_centre
 * +purpose. The control-account party rule still applies (an AP settlement line is party-tagged).
 *
 * PURCHASE is a per-line SPECIAL CASE (purchase-po-bill-posting, architectural decision 5), mirroring the
 * JOURNAL/OPENING per-line branch: godown is required only on a line that actually moves inventory
 * (`line.isStockLine === true`, a hint PUR's `buildPurchaseBillCommand` supplies); the AP/VAT-input/TDS/AIT
 * lines of the SAME bill carry project+cost_centre+purpose but NO godown (design §4.1's worked table —
 * those rows show godown "—"). The flat `REQUIRED.PURCHASE` list (still project+cost_centre+purpose+godown)
 * is used only as the fallback for a PURCHASE line that doesn't set `isStockLine` at all (defensive — no
 * currently-shipped caller omits the hint). STOCK_JOURNAL is unaffected — both its sides are always
 * inventory movements, so it keeps the flat REQUIRED list (all four dims on every line).
 */
import { PostingCommand, PostingLine } from './posting-command';
import { TagMatrixError } from './errors';
import { VoucherType } from './voucher-type';

export interface TagMatrix {
  assert(cmd: PostingCommand): void;
}

export const TAG_MATRIX = Symbol('TagMatrix');

type DimKey = 'projectId' | 'costCentreId' | 'purposeId' | 'godownId';
const DIM_LABEL: Record<DimKey, string> = {
  projectId: 'project_id',
  costCentreId: 'cost_centre_id',
  purposeId: 'purpose_id',
  godownId: 'godown_id',
};

const REQUIRED: Record<VoucherType, DimKey[]> = {
  SALES_IPC: ['projectId', 'costCentreId', 'purposeId'],
  PURCHASE: ['projectId', 'costCentreId', 'purposeId', 'godownId'],
  STOCK_JOURNAL: ['projectId', 'costCentreId', 'purposeId', 'godownId'],
  PAYMENT: [], // per-line by account type (see requiredDims) — only P&L lines require dimensions

  RECEIPT: ['costCentreId', 'purposeId'],
  SALARY: ['projectId', 'costCentreId', 'purposeId'],
  DAILY_LABOUR_ACCRUAL: ['projectId', 'costCentreId', 'purposeId'],
  JOURNAL: [], // per-line by account type
  CONTRA: [], // optional
  OPENING: [], // per-line by account type
};

const PNL_TYPES = new Set(['INCOME', 'EXPENSE']);

export class OverviewTagMatrix implements TagMatrix {
  assert(cmd: PostingCommand): void {
    for (const line of cmd.lines) {
      for (const dim of this.requiredDims(cmd.voucherType, line)) {
        if (!line[dim]) {
          throw new TagMatrixError(`${DIM_LABEL[dim]} is required for ${cmd.voucherType}`, {
            voucherType: cmd.voucherType,
            accountId: line.accountId,
            dimension: DIM_LABEL[dim],
          });
        }
      }
      if (line.isControlAccount && !line.partyId) {
        throw new TagMatrixError('party_id is required on AR/AP control-account lines', {
          accountId: line.accountId,
        });
      }
    }
  }

  private requiredDims(voucherType: VoucherType, line: PostingLine): DimKey[] {
    if (voucherType === 'JOURNAL' || voucherType === 'OPENING' || voucherType === 'PAYMENT') {
      return line.accountType && PNL_TYPES.has(line.accountType)
        ? ['projectId', 'costCentreId', 'purposeId']
        : [];
    }
    if (voucherType === 'PURCHASE') {
      // Per-line special case (decision 5): godown only on a line that moves inventory. A line that
      // doesn't set the `isStockLine` hint at all falls back to the flat (godown-required) list.
      return line.isStockLine === false
        ? ['projectId', 'costCentreId', 'purposeId']
        : REQUIRED.PURCHASE;
    }
    return REQUIRED[voucherType];
  }
}
