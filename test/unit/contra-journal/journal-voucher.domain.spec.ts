/**
 * JournalVoucher domain unit tests (PURE). Cites FR-GEN-004/-005/-006/-007/-014.
 * Covers: P&L line requires project+cost_centre+purpose; BS-only line may be untagged; any AR/AP
 * control line requires a party; line side + ≥2 lines + balance; conditional-tag pass-through to the
 * command; DRAFT-only lifecycle.
 */
import { JournalVoucher } from '../../../src/modules/contra-journal/domain/journal-voucher';
import { AccountClassificationSnapshot } from '../../../src/modules/contra-journal/domain/ports/account-classification.port';
import {
  MissingControlPartyError,
  MissingPnlDimensionError,
  NotDraftError,
} from '../../../src/modules/contra-journal/domain/errors';
import { ValidationError } from '../../../src/common/errors/domain-error';

const EXPENSE = 'acc-exp';
const LIABILITY = 'acc-accrued';
const AR = 'acc-ar';
const P = 'p1';
const CC = 'cc1';
const PURP = 'pu1';
const PARTY = 'party1';

const snapshot = AccountClassificationSnapshot.of({
  [EXPENSE]: { type: 'EXPENSE', isCashBank: false, isArApControl: false },
  [LIABILITY]: { type: 'LIABILITY', isCashBank: false, isArApControl: false },
  [AR]: { type: 'ASSET', isCashBank: false, isArApControl: true },
});

function draft(lines: unknown[]) {
  return JournalVoucher.createDraft(
    'jv1',
    'co1',
    'fy1',
    { voucherType: 'JOURNAL', voucherDate: '2026-06-29', lines: lines as never },
    snapshot,
  );
}

describe('JournalVoucher (FR-GEN-004..007)', () => {
  it('accepts a P&L line fully tagged + a BS-only line untagged, balanced (§4b)', () => {
    const v = draft([
      { accountId: EXPENSE, projectId: P, costCentreId: CC, purposeId: PURP, debit: '120000.0000' },
      { accountId: LIABILITY, credit: '120000.0000' },
    ]);
    const cmd = v.toPostingCommand('user1');
    expect(cmd.voucherType).toBe('JOURNAL');
    const pnl = cmd.lines.find((l) => l.accountId === EXPENSE)!;
    expect(pnl.projectId).toBe(P);
    expect(pnl.costCentreId).toBe(CC);
    expect(pnl.purposeId).toBe(PURP);
    expect(pnl.accountType).toBe('EXPENSE');
    const bs = cmd.lines.find((l) => l.accountId === LIABILITY)!;
    expect(bs.projectId).toBeUndefined();
    expect(bs.isControlAccount).toBe(false);
  });

  it('rejects a P&L line missing purpose (MissingPnlDimensionError names the dimension, FR-GEN-005)', () => {
    try {
      draft([
        { accountId: EXPENSE, projectId: P, costCentreId: CC, debit: '100.0000' },
        { accountId: LIABILITY, credit: '100.0000' },
      ]);
      fail('expected MissingPnlDimensionError');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingPnlDimensionError);
      expect((e as MissingPnlDimensionError).details).toMatchObject({ dimension: 'purpose_id' });
    }
  });

  it('rejects an AR/AP control line with no party (MissingControlPartyError, FR-GEN-007)', () => {
    expect(() =>
      draft([
        { accountId: EXPENSE, projectId: P, costCentreId: CC, purposeId: PURP, debit: '100.0000' },
        { accountId: AR, credit: '100.0000' },
      ]),
    ).toThrow(MissingControlPartyError);
  });

  it('accepts an AR/AP control line WITH a party and passes the party + control flag to the command', () => {
    const v = draft([
      { accountId: EXPENSE, projectId: P, costCentreId: CC, purposeId: PURP, debit: '100.0000' },
      { accountId: AR, partyId: PARTY, credit: '100.0000' },
    ]);
    const line = v.toPostingCommand('u1').lines.find((l) => l.accountId === AR)!;
    expect(line.partyId).toBe(PARTY);
    expect(line.isControlAccount).toBe(true);
  });

  it('rejects fewer than 2 lines and an imbalanced set', () => {
    expect(() => draft([{ accountId: LIABILITY, credit: '100.0000' }])).toThrow(ValidationError);
    expect(() =>
      draft([
        { accountId: LIABILITY, debit: '100.0000' },
        { accountId: LIABILITY, credit: '90.0000' },
      ]),
    ).toThrow();
  });

  it('is editable only while DRAFT (FR-GEN-014/-018)', () => {
    const v = draft([
      { accountId: LIABILITY, debit: '100.0000' },
      { accountId: LIABILITY, credit: '100.0000' },
    ]);
    v.markPosted('e1', 'JV/2526/0001', 'u1', new Date());
    expect(() => v.updateDraft({ voucherDate: '2026-07-01', lines: [] }, snapshot)).toThrow(NotDraftError);
  });
});
