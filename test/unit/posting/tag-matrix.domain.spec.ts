/**
 * TagMatrix domain unit tests (no DB/Nest) — required dimensions per voucher type + party-on-control
 * (overview §5.1, FR-LED-010..012).
 */
import { OverviewTagMatrix } from '../../../src/core/posting/domain/tag-matrix';
import { PostingCommand, PostingLine } from '../../../src/core/posting/domain/posting-command';
import { TagMatrixError } from '../../../src/core/posting/domain/errors';
import { VoucherType } from '../../../src/core/posting/domain/voucher-type';
import { Money } from '../../../src/common/money';

const matrix = new OverviewTagMatrix();

function cmd(voucherType: VoucherType, lines: Partial<PostingLine>[]): PostingCommand {
  return {
    companyId: 'co-1',
    financialYearId: 'fy-1',
    voucherType,
    voucherDate: '2025-07-15',
    sourceType: voucherType,
    sourceId: 'src-1',
    postedBy: 'u-1',
    lines: lines.map((l) => ({ accountId: 'a', debit: Money.of('1'), credit: Money.zero(), ...l })),
  };
}

const fullDims = { projectId: 'p', costCentreId: 'c', purposeId: 'pu' };

describe('OverviewTagMatrix', () => {
  it('SALES_IPC requires project+cost_centre+purpose on every line', () => {
    expect(() => matrix.assert(cmd('SALES_IPC', [fullDims, fullDims]))).not.toThrow();
    expect(() => matrix.assert(cmd('SALES_IPC', [{ costCentreId: 'c', purposeId: 'pu' }]))).toThrow(
      TagMatrixError,
    );
  });

  it('PURCHASE additionally requires godown (AC9)', () => {
    expect(() => matrix.assert(cmd('PURCHASE', [{ ...fullDims, godownId: 'g' }]))).not.toThrow();
    expect(() => matrix.assert(cmd('PURCHASE', [fullDims]))).toThrow(/godown_id is required for PURCHASE/);
  });

  it('requires party on AR/AP control-account lines regardless of voucher type', () => {
    expect(() =>
      matrix.assert(cmd('SALES_IPC', [{ ...fullDims, isControlAccount: true }])),
    ).toThrow(/party_id is required/);
    expect(() =>
      matrix.assert(cmd('SALES_IPC', [{ ...fullDims, isControlAccount: true, partyId: 'party-1' }])),
    ).not.toThrow();
  });

  it('JOURNAL P&L line (INCOME/EXPENSE) needs dimensions; a balance-sheet line does not', () => {
    expect(() => matrix.assert(cmd('JOURNAL', [{ accountType: 'EXPENSE' }]))).toThrow(TagMatrixError);
    expect(() => matrix.assert(cmd('JOURNAL', [{ accountType: 'EXPENSE', ...fullDims }]))).not.toThrow();
    expect(() => matrix.assert(cmd('JOURNAL', [{ accountType: 'ASSET' }]))).not.toThrow();
  });

  it('CONTRA requires no dimensions', () => {
    expect(() => matrix.assert(cmd('CONTRA', [{}, {}]))).not.toThrow();
  });
});
