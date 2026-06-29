/** Maps JournalEntry (domain) ↔ journal_entry/journal_line ORM rows. INFRASTRUCTURE. */
import { randomUUID } from 'node:crypto';
import { Money } from '../../../common/money';
import { JournalEntry, JournalLine } from '../domain/journal-entry';
import { VoucherType } from '../domain/voucher-type';
import { JournalEntryOrmEntity } from './journal-entry.orm-entity';
import { JournalLineOrmEntity } from './journal-line.orm-entity';

export const JournalEntryMapper = {
  toOrm(entry: JournalEntry): { entry: JournalEntryOrmEntity; lines: JournalLineOrmEntity[] } {
    const p = entry.props;
    const e = new JournalEntryOrmEntity();
    e.id = entry.id;
    e.companyId = p.companyId;
    e.financialYearId = p.financialYearId;
    e.entryNo = p.entryNo;
    e.voucherType = p.voucherType;
    e.voucherDate = p.voucherDate;
    e.sourceType = p.sourceType;
    e.sourceId = p.sourceId;
    e.isReversal = p.isReversal;
    e.reversalOf = p.reversalOf;
    e.postedAt = p.postedAt;
    e.postedBy = p.postedBy;
    e.narration = p.narration;

    const lines = p.lines.map((l) => {
      const ol = new JournalLineOrmEntity();
      ol.id = randomUUID();
      ol.journalEntryId = entry.id;
      ol.lineNo = l.lineNo;
      ol.accountId = l.props.accountId;
      ol.projectId = l.props.projectId;
      ol.costCentreId = l.props.costCentreId;
      ol.purposeId = l.props.purposeId;
      ol.godownId = l.props.godownId;
      ol.partyId = l.props.partyId;
      ol.debit = l.props.debit.amount;
      ol.credit = l.props.credit.amount;
      ol.narration = l.props.narration;
      return ol;
    });
    return { entry: e, lines };
  },

  toDomain(e: JournalEntryOrmEntity, lineRows: JournalLineOrmEntity[]): JournalEntry {
    const lines = [...lineRows]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((ol) =>
        JournalLine.rehydrate(ol.lineNo, {
          accountId: ol.accountId,
          projectId: ol.projectId,
          costCentreId: ol.costCentreId,
          purposeId: ol.purposeId,
          godownId: ol.godownId,
          partyId: ol.partyId,
          debit: Money.of(ol.debit),
          credit: Money.of(ol.credit),
          narration: ol.narration,
        }),
      );
    return JournalEntry.rehydrate(e.id, {
      companyId: e.companyId,
      financialYearId: e.financialYearId,
      entryNo: e.entryNo,
      voucherType: e.voucherType as VoucherType,
      voucherDate: e.voucherDate,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      isReversal: e.isReversal,
      reversalOf: e.reversalOf,
      postedAt: e.postedAt,
      postedBy: e.postedBy,
      narration: e.narration,
      lines,
    });
  },
};
