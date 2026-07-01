/**
 * ContraVoucherMapper (INFRASTRUCTURE) — translates the pure ContraVoucher aggregate ↔ the
 * `contra_voucher` + `contra_line` ORM rows. The domain never imports TypeORM; this is the only seam.
 */
import Decimal from 'decimal.js';
import { ContraLine, ContraVoucher } from '../domain/contra-voucher';
import { VoucherStatus } from '../domain/voucher-status';
import { ContraLineOrmEntity, ContraVoucherOrmEntity } from './contra-voucher.orm-entity';

export const ContraVoucherMapper = {
  toOrm(v: ContraVoucher): { header: ContraVoucherOrmEntity; lines: ContraLineOrmEntity[] } {
    const p = v.props;
    const header = new ContraVoucherOrmEntity();
    header.id = v.id;
    header.companyId = p.companyId;
    header.financialYearId = p.financialYearId;
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

  toDomain(header: ContraVoucherOrmEntity, lineRows: ContraLineOrmEntity[]): ContraVoucher {
    const lines = [...lineRows]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((r) =>
        ContraLine.rehydrate({
          lineNo: r.lineNo,
          accountId: r.accountId,
          debit: new Decimal(r.debit),
          credit: new Decimal(r.credit),
          narration: r.narration,
        }),
      );
    return ContraVoucher.rehydrate(header.id, {
      companyId: header.companyId,
      financialYearId: header.financialYearId,
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

function lineToOrm(voucherId: string, l: ContraLine): ContraLineOrmEntity {
  const e = new ContraLineOrmEntity();
  // deterministic per-voucher line id (voucher + line_no) is not needed; a fresh uuid per persist is
  // fine because we delete-and-reinsert lines on save. The repository supplies the id.
  e.contraVoucherId = voucherId;
  e.lineNo = l.props.lineNo;
  e.accountId = l.props.accountId;
  e.debit = l.props.debit;
  e.credit = l.props.credit;
  e.narration = l.props.narration;
  return e;
}
