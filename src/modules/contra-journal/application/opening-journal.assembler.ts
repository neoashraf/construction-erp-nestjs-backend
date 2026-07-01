/**
 * OpeningJournalAssembler — MAS account/party opening_balance → one balanced OPENING JournalVoucher
 * draft (design §2.4, FR-GEN-009..013). For each account with a non-zero opening balance it emits a
 * line on that account's natural side; for each party it emits a line on the AR control (party owes us →
 * debit) or AP control (we owe party → credit) account CARRYING that party; a single opening-balance-
 * equity line absorbs the net so Σdebit = Σcredit by construction (LED re-checks at post).
 *
 * The assembler resolves the AR/AP-control + opening-equity accounts (ControlAccountResolver) and builds
 * the account-classification snapshot the aggregate needs (control accounts flagged so the party rule
 * fires, opening-equity/account lines classified for the tag matrix). It is IO-bound (reads MAS) and so
 * lives in the application layer; the aggregate it returns is pure.
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { AccountType } from '../../../core/posting/domain/posting-command';
import {
  JournalVoucher,
  NewJournalLine,
} from '../domain/journal-voucher';
import {
  AccountClassificationSnapshot,
  AccountFacts,
} from '../domain/ports/account-classification.port';
import {
  CONTROL_ACCOUNT_RESOLVER,
  ControlAccountResolver,
  OPENING_BALANCE_READER,
  OpeningBalanceReader,
} from '../domain/ports/opening-balance.port';

const DEBIT_NATURAL = new Set<AccountType>(['ASSET', 'EXPENSE']);

@Injectable()
export class OpeningJournalAssembler {
  constructor(
    @Inject(OPENING_BALANCE_READER) private readonly mas: OpeningBalanceReader,
    @Inject(CONTROL_ACCOUNT_RESOLVER) private readonly accounts: ControlAccountResolver,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async assemble(
    companyId: string,
    financialYearId: string,
    voucherDate: string,
    narration: string | null,
  ): Promise<JournalVoucher> {
    const [accountOpenings, partyOpenings, arControl, apControl, openingEquity] = await Promise.all([
      this.mas.accountsWithOpening(companyId),
      this.mas.partiesWithOpening(companyId),
      this.accounts.arControlAccount(companyId),
      this.accounts.apControlAccount(companyId),
      this.accounts.openingEquityAccount(companyId),
    ]);

    const lines: NewJournalLine[] = [];
    const facts = new Map<string, AccountFacts>();
    let netDebitMinusCredit = new Decimal(0); // debits positive, credits negative

    // ---- account opening lines (balance-sheet-only ⇒ may be untagged; on their natural side) ------
    for (const acc of accountOpenings) {
      const amount = new Decimal(acc.amount);
      if (amount.isZero()) continue;
      facts.set(acc.accountId, { type: acc.type, isCashBank: false, isArApControl: false });
      if (DEBIT_NATURAL.has(acc.type)) {
        lines.push({ accountId: acc.accountId, debit: amount.toFixed(4) });
        netDebitMinusCredit = netDebitMinusCredit.plus(amount);
      } else {
        lines.push({ accountId: acc.accountId, credit: amount.toFixed(4) });
        netDebitMinusCredit = netDebitMinusCredit.minus(amount);
      }
    }

    // ---- party opening lines (AR debit / AP credit, party on the control line) --------------------
    facts.set(arControl, { type: 'ASSET', isCashBank: false, isArApControl: true });
    facts.set(apControl, { type: 'LIABILITY', isCashBank: false, isArApControl: true });
    for (const p of partyOpenings) {
      const amount = new Decimal(p.amount);
      if (amount.isZero()) continue;
      if (amount.isPositive()) {
        // party owes us → AR control, debit, party on the line (FR-GEN-011)
        lines.push({ accountId: arControl, partyId: p.partyId, debit: amount.toFixed(4) });
        netDebitMinusCredit = netDebitMinusCredit.plus(amount);
      } else {
        // we owe the party → AP control, credit, party on the line
        const mag = amount.abs();
        lines.push({ accountId: apControl, partyId: p.partyId, credit: mag.toFixed(4) });
        netDebitMinusCredit = netDebitMinusCredit.minus(mag);
      }
    }

    // ---- balancing opening-balance-equity line (absorbs the net so Σdr = Σcr) ----------------------
    // Emitted only when the account+party lines don't already net to zero (a zero-side line would
    // violate the line-side invariant). When they already balance, no equity line is needed.
    facts.set(openingEquity, { type: 'EQUITY', isCashBank: false, isArApControl: false });
    if (netDebitMinusCredit.isPositive()) {
      // more debits than credits → credit the equity account
      lines.push({ accountId: openingEquity, credit: netDebitMinusCredit.toFixed(4) });
    } else if (netDebitMinusCredit.isNegative()) {
      // more credits than debits → debit the equity account
      lines.push({ accountId: openingEquity, debit: netDebitMinusCredit.abs().toFixed(4) });
    }

    const snapshot = new AccountClassificationSnapshot(facts);
    return JournalVoucher.createDraft(
      this.ids.next(),
      companyId,
      financialYearId,
      { voucherType: 'OPENING', voucherDate, narration, lines },
      snapshot,
    );
  }
}
