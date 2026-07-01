/**
 * ContraVoucher domain unit tests (PURE — no DB, no Nest). Cites FR-GEN-001/-002/-003/-014/-016.
 * Covers: the bank/cash account restriction, no-party rule, ≥2 lines + line side, pre-flight balance,
 * the CONTRA command shape (no dims/party), and the DRAFT-only lifecycle guards.
 */
import { ContraVoucher } from '../../../src/modules/contra-journal/domain/contra-voucher';
import { AccountClassificationSnapshot } from '../../../src/modules/contra-journal/domain/ports/account-classification.port';
import {
  ContraPartyNotAllowedError,
  NotBankCashAccountError,
  NotDraftError,
  UnbalancedEntryError,
} from '../../../src/modules/contra-journal/domain/errors';
import { ValidationError } from '../../../src/common/errors/domain-error';

const CASH = 'acc-cash';
const BANK = 'acc-bank';
const EXPENSE = 'acc-expense';
const AR = 'acc-ar';

const cashBankSnapshot = AccountClassificationSnapshot.of({
  [CASH]: { type: 'ASSET', isCashBank: true, isArApControl: false },
  [BANK]: { type: 'ASSET', isCashBank: true, isArApControl: false },
  [EXPENSE]: { type: 'EXPENSE', isCashBank: false, isArApControl: false },
  [AR]: { type: 'ASSET', isCashBank: true, isArApControl: true },
});

function draft(lines: Array<{ accountId: string; debit?: string; credit?: string }>) {
  return ContraVoucher.createDraft('cv1', 'co1', 'fy1', { voucherDate: '2026-06-29', lines }, cashBankSnapshot);
}

describe('ContraVoucher (FR-GEN-001/-002/-003)', () => {
  it('creates a valid bank↔cash contra and builds a balanced CONTRA command with no dims/party', () => {
    const v = draft([
      { accountId: BANK, debit: '500000.0000' },
      { accountId: CASH, credit: '500000.0000' },
    ]);
    const cmd = v.toPostingCommand('user1');
    expect(cmd.voucherType).toBe('CONTRA');
    expect(cmd.lines).toHaveLength(2);
    for (const l of cmd.lines) {
      expect(l.projectId).toBeUndefined();
      expect(l.costCentreId).toBeUndefined();
      expect(l.purposeId).toBeUndefined();
      expect(l.partyId).toBeUndefined();
      expect(l.isControlAccount).toBe(false);
    }
    const dr = cmd.lines.reduce((s, l) => s.plus(l.debit.amount), cmd.lines[0].debit.amount.mul(0));
    const cr = cmd.lines.reduce((s, l) => s.plus(l.credit.amount), cmd.lines[0].credit.amount.mul(0));
    expect(dr.equals(cr)).toBe(true);
  });

  it('rejects a line on a non-bank/cash account (NotBankCashAccountError, FR-GEN-003)', () => {
    expect(() =>
      draft([
        { accountId: EXPENSE, debit: '100.0000' },
        { accountId: CASH, credit: '100.0000' },
      ]),
    ).toThrow(NotBankCashAccountError);
  });

  it('rejects a line on an AR/AP control account — a contra carries no party (FR-GEN-003)', () => {
    expect(() =>
      draft([
        { accountId: AR, debit: '100.0000' },
        { accountId: CASH, credit: '100.0000' },
      ]),
    ).toThrow(ContraPartyNotAllowedError);
  });

  it('rejects fewer than 2 lines (ValidationError)', () => {
    expect(() => draft([{ accountId: BANK, debit: '100.0000' }])).toThrow(ValidationError);
  });

  it('rejects a line with both debit and credit non-zero (line side)', () => {
    expect(() =>
      draft([
        { accountId: BANK, debit: '100.0000', credit: '50.0000' },
        { accountId: CASH, credit: '100.0000' },
      ]),
    ).toThrow(ValidationError);
  });

  it('rejects an imbalanced contra at pre-flight (UnbalancedEntryError, FR-GEN-016)', () => {
    expect(() =>
      draft([
        { accountId: BANK, debit: '100.0000' },
        { accountId: CASH, credit: '90.0000' },
      ]),
    ).toThrow(UnbalancedEntryError);
  });

  it('is editable only while DRAFT; markPosted then updateDraft → NotDraftError (FR-GEN-014/-018)', () => {
    const v = draft([
      { accountId: BANK, debit: '100.0000' },
      { accountId: CASH, credit: '100.0000' },
    ]);
    v.markPosted('e1', 'CN/2526/0001', 'user1', new Date());
    expect(v.props.status).toBe('POSTED');
    expect(() =>
      v.updateDraft({ voucherDate: '2026-06-30', lines: [] }, cashBankSnapshot),
    ).toThrow(NotDraftError);
    expect(() => v.assertPostable()).toThrow(NotDraftError);
  });

  it('markCancelled only from POSTED', () => {
    const v = draft([
      { accountId: BANK, debit: '100.0000' },
      { accountId: CASH, credit: '100.0000' },
    ]);
    expect(() => v.markCancelled()).toThrow(NotDraftError); // still DRAFT
    v.markPosted('e1', 'CN/2526/0001', 'user1', new Date());
    v.markCancelled();
    expect(v.props.status).toBe('CANCELLED');
  });
});
