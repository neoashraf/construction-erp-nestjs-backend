/**
 * JournalVoucherMapper (INFRASTRUCTURE) — translates the pure JournalVoucher aggregate ↔ the
 * `journal_voucher` + `journal_line_draft` ORM rows. The domain never imports TypeORM; this is the seam.
 */
import Decimal from 'decimal.js';
import { AccountType } from '../../../core/posting/domain/posting-command';
import {
  JournalLine,
  JournalVoucher,
  JournalVoucherType,
} from '../domain/journal-voucher';
import { VoucherStatus } from '../domain/voucher-status';
import { JournalLineDraftOrmEntity, JournalVoucherOrmEntity } from './journal-voucher.orm-entity';

export const JournalVoucherMapper = {
  toOrm(v: JournalVoucher): { header: JournalVoucherOrmEntity; lines: JournalLineDraftOrmEntity[] } {
    const p = v.props;
    const header = new JournalVoucherOrmEntity();
    header.id = v.id;
    header.companyId = p.companyId;
    header.financialYearId = p.financialYearId;
    header.voucherType = p.voucherType;
    header.voucherDate = p.voucherDate;
    header.narration = p.narration;
    header.status = p.status;
    header.entryNo = p.entryNo;
    header.journalEntryId = p.journalEntryId;
    header.postedAt = p.postedAt;
    header.postedBy = p.postedBy;
    header.deletedAt = null;
    const lines = p.lines.map((l) => lineToOrm(v.id, l));
    return { header, lines };
  },

  toDomain(header: JournalVoucherOrmEntity, lineRows: JournalLineDraftOrmEntity[]): JournalVoucher {
    const lines = [...lineRows]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((r) =>
        JournalLine.rehydrate({
          lineNo: r.lineNo,
          accountId: r.accountId,
          projectId: r.projectId,
          costCentreId: r.costCentreId,
          purposeId: r.purposeId,
          partyId: r.partyId,
          accountType: (r.accountType as AccountType | null) ?? null,
          isControlAccount: r.isControlAccount,
          debit: new Decimal(r.debit),
          credit: new Decimal(r.credit),
          narration: r.narration,
        }),
      );
    return JournalVoucher.rehydrate(header.id, {
      companyId: header.companyId,
      financialYearId: header.financialYearId,
      voucherType: header.voucherType as JournalVoucherType,
      voucherDate: header.voucherDate,
      narration: header.narration,
      status: header.status as VoucherStatus,
      entryNo: header.entryNo,
      journalEntryId: header.journalEntryId,
      postedAt: header.postedAt,
      postedBy: header.postedBy,
      version: header.version,
      lines,
    });
  },
};

function lineToOrm(voucherId: string, l: JournalLine): JournalLineDraftOrmEntity {
  const e = new JournalLineDraftOrmEntity();
  e.journalVoucherId = voucherId;
  e.lineNo = l.props.lineNo;
  e.accountId = l.props.accountId;
  e.projectId = l.props.projectId;
  e.costCentreId = l.props.costCentreId;
  e.purposeId = l.props.purposeId;
  e.partyId = l.props.partyId;
  e.accountType = l.props.accountType;
  e.isControlAccount = l.props.isControlAccount;
  e.debit = l.props.debit;
  e.credit = l.props.credit;
  e.narration = l.props.narration;
  return e;
}
