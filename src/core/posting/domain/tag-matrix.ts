/**
 * TagMatrix — LED domain service (PURE) mirroring the canonical tag-requirement matrix (overview §5.1).
 * `assert(cmd)` rejects any line missing a dimension REQUIRED for its voucher type, and any AR/AP
 * control-account line missing a party (FR-LED-010..012). Optional dimensions are accepted, not required.
 *
 * For JOURNAL / CONTRA / OPENING the requirement is per-line by account type: a P&L line
 * (INCOME/EXPENSE) needs project+cost_centre+purpose; a balance-sheet line is optional. CONTRA lines are
 * optional. The party rule is keyed on the account being a control account, regardless of voucher type
 * (design §10 item 3). RECEIPT requires cost_centre+purpose; project is supplied by the REC module for
 * IPC-linked receipts (it knows the IPC link) — LED enforces what it can see on the command.
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
  PAYMENT: ['projectId', 'costCentreId', 'purposeId'],
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
    if (voucherType === 'JOURNAL' || voucherType === 'OPENING') {
      return line.accountType && PNL_TYPES.has(line.accountType)
        ? ['projectId', 'costCentreId', 'purposeId']
        : [];
    }
    return REQUIRED[voucherType];
  }
}
