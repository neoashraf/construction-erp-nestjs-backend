/**
 * StockJournalMapper (INFRASTRUCTURE) — translates the pure StockJournal aggregate ↔ the `stock_journal` +
 * `stock_journal_line` ORM rows. The domain never imports TypeORM; this is the only seam.
 */
import Decimal from 'decimal.js';
import {
  StockJournal,
  StockJournalLine,
  StockJournalSide,
  StockJournalStatus,
} from '../domain/stock-journal';
import { StockJournalMode } from '../domain/stock-journal-mode';
import { StockJournalLineOrmEntity, StockJournalOrmEntity } from './stock-journal.orm-entity';

export const StockJournalMapper = {
  toOrm(v: StockJournal): { header: StockJournalOrmEntity; lines: StockJournalLineOrmEntity[] } {
    const p = v.props;
    const header = new StockJournalOrmEntity();
    header.id = v.id;
    header.companyId = p.companyId;
    header.financialYearId = p.financialYearId;
    header.entryNo = p.entryNo;
    header.voucherDate = p.voucherDate;
    header.mode = p.mode;
    header.status = p.status;
    header.fromGodownId = p.fromGodownId;
    header.toGodownId = p.toGodownId;
    header.itemId = p.itemId;
    header.quantity = p.quantity;
    header.rate = p.rate;
    header.value = p.value;
    header.projectId = p.projectId;
    header.costCentreId = p.costCentreId;
    header.purposeId = p.purposeId;
    header.issuedById = p.issuedById;
    header.receivedById = p.receivedById;
    header.approvedById = p.approvedById;
    header.approvedAt = p.approvedAt;
    header.allowNegativeStock = p.allowNegativeStock;
    header.negativeStockAuthorisedById = p.negativeStockAuthorisedById;
    header.negativeStockReason = p.negativeStockReason;
    header.journalEntryId = p.journalEntryId;
    header.narration = p.narration;
    header.postedAt = p.postedAt;
    header.postedById = p.postedById;
    header.deletedAt = null;
    const lines = p.lines.map((l) => lineToOrm(v.id, l));
    return { header, lines };
  },

  toDomain(header: StockJournalOrmEntity, lineRows: StockJournalLineOrmEntity[]): StockJournal {
    const lines = [...lineRows]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((r) =>
        StockJournalLine.rehydrate({
          lineNo: r.lineNo,
          side: r.side as StockJournalSide,
          godownId: r.godownId,
          itemId: r.itemId,
          quantity: new Decimal(r.quantity),
          rate: r.rate == null ? null : new Decimal(r.rate),
          value: r.value == null ? null : new Decimal(r.value),
          projectId: r.projectId,
          costCentreId: r.costCentreId,
          purposeId: r.purposeId,
        }),
      );
    return StockJournal.rehydrate(header.id, {
      companyId: header.companyId,
      financialYearId: header.financialYearId,
      entryNo: header.entryNo,
      voucherDate: header.voucherDate,
      mode: header.mode as StockJournalMode,
      status: header.status as StockJournalStatus,
      fromGodownId: header.fromGodownId,
      toGodownId: header.toGodownId,
      itemId: header.itemId,
      quantity: new Decimal(header.quantity),
      rate: header.rate == null ? null : new Decimal(header.rate),
      value: header.value == null ? null : new Decimal(header.value),
      projectId: header.projectId,
      costCentreId: header.costCentreId,
      purposeId: header.purposeId,
      issuedById: header.issuedById,
      receivedById: header.receivedById,
      approvedById: header.approvedById,
      approvedAt: header.approvedAt,
      allowNegativeStock: header.allowNegativeStock,
      negativeStockAuthorisedById: header.negativeStockAuthorisedById,
      negativeStockReason: header.negativeStockReason,
      journalEntryId: header.journalEntryId,
      narration: header.narration,
      postedAt: header.postedAt,
      postedById: header.postedById,
      version: header.version,
      lines,
    });
  },
};

function lineToOrm(journalId: string, l: StockJournalLine): StockJournalLineOrmEntity {
  const e = new StockJournalLineOrmEntity();
  e.stockJournalId = journalId;
  e.lineNo = l.props.lineNo;
  e.side = l.props.side;
  e.godownId = l.props.godownId;
  e.itemId = l.props.itemId;
  e.quantity = l.props.quantity;
  e.rate = l.props.rate;
  e.value = l.props.value;
  e.projectId = l.props.projectId;
  e.costCentreId = l.props.costCentreId;
  e.purposeId = l.props.purposeId;
  return e;
}
