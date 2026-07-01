/**
 * buildConsumptionCommand — the REQ issue's consumption `PostingCommand` (design §4.1/§4.3). IDENTICAL to
 * `PostStockJournalUseCase`'s ISSUE branch (`outLine && !inLine`): Dr material expense (EXPENSE, from
 * `InventoryAccountResolver.expenseAccountOf`) / Cr inventory (ASSET, from
 * `InventoryAccountResolver.inventoryAccountOf(companyId, itemId)`), both lines tagged
 * project + cost_centre + purpose + godown, no party. ONE `PostingCommand` covers every issued line — a
 * multi-item issue gets an expense/inventory pair PER ITEM, balanced overall (FR-REQ-014, edge from design
 * §4.3). `voucherType:'STOCK_JOURNAL'`, `sourceType:'REQ_ISSUE'`, `sourceId: <the RequisitionIssue id>`
 * (design §4.1's exact `source_type = REQ_ISSUE` note). REQ builds this command; it never writes a journal
 * line itself — `PostingService.post` does (CLAUDE.md "one posting layer").
 */
import { Money } from '../../../common/money';
import { PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { InventoryAccountResolver } from '../domain/ports/inventory-account-resolver.port';

export interface ConsumptionCommandLine {
  itemId: string;
  godownId: string;
  value: import('decimal.js').default;
}

export interface ConsumptionCommandInput {
  companyId: string;
  financialYearId: string;
  voucherDate: string;
  projectId: string;
  costCentreId: string;
  purposeId: string;
  postedBy: string;
  sourceId: string;
  lines: ConsumptionCommandLine[];
}

export async function buildConsumptionCommand(
  input: ConsumptionCommandInput,
  accounts: InventoryAccountResolver,
): Promise<PostingCommand> {
  const expenseAccountId = await accounts.expenseAccountOf(input.companyId);
  const lines: PostingLine[] = [];
  for (const line of input.lines) {
    const inventoryAccountId = await accounts.inventoryAccountOf(input.companyId, line.itemId);
    lines.push(
      {
        accountId: expenseAccountId,
        projectId: input.projectId,
        costCentreId: input.costCentreId,
        purposeId: input.purposeId,
        godownId: line.godownId,
        debit: Money.of(line.value),
        credit: Money.zero(),
        accountType: 'EXPENSE',
        isControlAccount: false,
      },
      {
        accountId: inventoryAccountId,
        projectId: input.projectId,
        costCentreId: input.costCentreId,
        purposeId: input.purposeId,
        godownId: line.godownId,
        debit: Money.zero(),
        credit: Money.of(line.value),
        accountType: 'ASSET',
        isControlAccount: false,
      },
    );
  }
  return {
    companyId: input.companyId,
    financialYearId: input.financialYearId,
    voucherType: 'STOCK_JOURNAL',
    voucherDate: input.voucherDate,
    sourceType: 'REQ_ISSUE',
    sourceId: input.sourceId,
    postedBy: input.postedBy,
    lines,
  };
}
