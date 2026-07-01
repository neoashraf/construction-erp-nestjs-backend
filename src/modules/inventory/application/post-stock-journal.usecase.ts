/**
 * PostStockJournalUseCase — post an APPROVED Stock Journal atomically (design §5.2, FR-INV-010/-014
 * ..-020). Inside ONE uow.run:
 *   1. row-lock the draft (findByIdForUpdate) — anti-double-post;
 *   2. assertPostable() — must be APPROVED (edge 3);
 *   3. per OUT side: lock the (godown,item) balance, `valueIssue` (negative-stock guard, FR-INV-003/-014),
 *      append the OUT movement;
 *   4. per IN side (transfer): lock the (godown,item) balance, `applyTransferIn` (value-neutral in,
 *      FR-INV-011), append the IN movement;
 *   5. build the mode-specific `PostingCommand` (issue: Dr expense/Cr inventory; same-account transfer:
 *      no command; cross-account transfer: Dr to-inventory/Cr from-inventory) via the
 *      `InventoryAccountResolver` — INV writes NO journal line itself (FR-INV-016/-017);
 *   6. `posting.post(cmd)` only when a command exists;
 *   7. markPosted + save + audit — all inside the ONE uow.run (FR-INV-018).
 * `allowNegativeStock=true` requires a non-empty `negativeStockReason` (architectural decision 6,
 * validated here as a ValidationError; the DTO layer re-validates for a fast 400).
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-error';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import { PostingCommand, PostingLine } from '../../../core/posting/domain/posting-command';
import { PostingService } from '../../../core/posting/application/posting.service';
import { Money } from '../../../common/money';
import { applyTransferIn, valueIssue } from '../domain/valuation';
import { StockMovement } from '../domain/stock-movement';
import { StockJournal, StockJournalLine } from '../domain/stock-journal';
import { STOCK_JOURNAL_REPOSITORY, StockJournalRepository } from '../domain/ports/stock-journal.repository';
import { STOCK_MOVEMENT_REPOSITORY, StockMovementRepository } from '../domain/ports/stock-movement.repository';
import {
  INVENTORY_ACCOUNT_RESOLVER,
  InventoryAccountResolver,
} from '../domain/ports/inventory-account-resolver.port';

export const STOCK_JOURNAL_SOURCE_TYPE = 'STOCK_JOURNAL';

export interface PostStockJournalInput {
  allowNegativeStock?: boolean;
  negativeStockReason?: string | null;
}

@Injectable()
export class PostStockJournalUseCase {
  constructor(
    @Inject(STOCK_JOURNAL_REPOSITORY) private readonly journals: StockJournalRepository,
    @Inject(STOCK_MOVEMENT_REPOSITORY) private readonly movements: StockMovementRepository,
    private readonly posting: PostingService,
    @Inject(INVENTORY_ACCOUNT_RESOLVER) private readonly accounts: InventoryAccountResolver,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(
    id: string,
    input: PostStockJournalInput,
    actor: Actor,
  ): Promise<{ entryNo: string | null; journalEntryId: string | null }> {
    const allowNegativeStock = input.allowNegativeStock ?? false;
    if (allowNegativeStock && !(input.negativeStockReason ?? '').trim()) {
      throw new ValidationError('negativeStockReason is required when allowNegativeStock=true', {});
    }

    return this.uow.run(async () => {
      const journal = await this.journals.findByIdForUpdate(id, actor.companyId);
      if (!journal) throw new NotFoundError(`Stock Journal ${id} not found`);
      journal.assertPostable();

      journal.recordNegativeStockAuthorisation(
        allowNegativeStock ? actor.userId : null,
        allowNegativeStock ? (input.negativeStockReason ?? null) : null,
      );

      const now = this.clock.now();
      const postedLines: StockJournalLine[] = [];
      let outValue: Decimal = new Decimal(0);
      let outRate: Decimal = new Decimal(0);

      // --- OUT side (ISSUE / TRANSFER / single-sided ADJUSTMENT-out) ---
      const outLine = journal.toLines().find((l) => l.props.side === 'OUT') ?? null;
      if (outLine) {
        const prev = await this.movements.currentBalanceForUpdate(
          actor.companyId,
          outLine.props.godownId,
          outLine.props.itemId,
        );
        const { issuedValue, rate, newBalance } = valueIssue(prev, outLine.props.quantity, {
          allowNegative: allowNegativeStock,
        });
        outValue = issuedValue;
        outRate = rate;
        const movement = StockMovement.create(
          {
            companyId: actor.companyId,
            godownId: outLine.props.godownId,
            itemId: outLine.props.itemId,
            sourceType: STOCK_JOURNAL_SOURCE_TYPE,
            sourceId: journal.id,
            direction: 'OUT',
            quantity: outLine.props.quantity,
            rate,
            value: issuedValue,
            balanceAfter: newBalance,
            voucherDate: journal.props.voucherDate,
            postedBy: actor.userId,
          },
          this.ids.next(),
          now,
        );
        await this.movements.append(movement);
        postedLines.push(outLine.withValuation(rate, issuedValue));
      }

      // --- IN side (TRANSFER only) — value-neutral in, receives exactly the value that left the source ---
      const inLine = journal.toLines().find((l) => l.props.side === 'IN') ?? null;
      if (inLine) {
        const prevIn = await this.movements.currentBalanceForUpdate(
          actor.companyId,
          inLine.props.godownId,
          inLine.props.itemId,
        );
        const newBalanceIn = applyTransferIn(prevIn, inLine.props.quantity, outValue);
        const movementIn = StockMovement.create(
          {
            companyId: actor.companyId,
            godownId: inLine.props.godownId,
            itemId: inLine.props.itemId,
            sourceType: STOCK_JOURNAL_SOURCE_TYPE,
            sourceId: journal.id,
            direction: 'IN',
            quantity: inLine.props.quantity,
            rate: outRate,
            value: outValue,
            balanceAfter: newBalanceIn,
            voucherDate: journal.props.voucherDate,
            postedBy: actor.userId,
          },
          this.ids.next(),
          now,
        );
        await this.movements.append(movementIn);
        postedLines.push(inLine.withValuation(outRate, outValue));
      }

      // --- ledger (per mode) via the ONE posting layer (FR-INV-016/-017) ---
      const cmd = await this.buildPostingCommand(journal, outLine, inLine, outValue, actor);
      const entry = cmd ? await this.posting.post(cmd) : null;

      journal.markPosted(
        entry?.props.entryNo ?? null,
        entry?.id ?? null,
        outRate,
        outValue,
        postedLines,
        actor.userId,
        now,
      );
      await this.journals.save(journal, journal.version);
      await this.audit.record({
        action: 'POST',
        entityType: 'StockJournal',
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { entryNo: entry?.props.entryNo ?? null, journalEntryId: entry?.id ?? null };
    });
  }

  /**
   * §4.1 ISSUE → Dr material expense / Cr inventory. §4.2 same-account TRANSFER → null (no entry).
   * §4.3 cross-account TRANSFER → Dr to-inventory / Cr from-inventory. ADJUSTMENT (single-sided,
   * out-of-scope beyond side-presence per the brief) posts no entry — mirrors the same-account path.
   */
  private async buildPostingCommand(
    journal: StockJournal,
    outLine: StockJournalLine | null,
    inLine: StockJournalLine | null,
    outValue: Decimal,
    actor: Actor,
  ): Promise<PostingCommand | null> {
    const { companyId, financialYearId, voucherDate, itemId } = journal.props;

    if (outLine && inLine) {
      // TRANSFER — compare the two sides' resolved inventory account.
      const fromAccountId = await this.accounts.inventoryAccountOf(companyId, itemId);
      const toAccountId = await this.accounts.inventoryAccountOf(companyId, itemId);
      if (fromAccountId === toAccountId) {
        return null; // §4.2 value-neutral, same account — no ledger entry, no number.
      }
      const lines: PostingLine[] = [
        {
          accountId: toAccountId,
          projectId: inLine.props.projectId,
          costCentreId: inLine.props.costCentreId,
          purposeId: inLine.props.purposeId,
          godownId: inLine.props.godownId,
          debit: Money.of(outValue),
          credit: Money.zero(),
          accountType: 'ASSET',
          isControlAccount: false,
        },
        {
          accountId: fromAccountId,
          projectId: outLine.props.projectId,
          costCentreId: outLine.props.costCentreId,
          purposeId: outLine.props.purposeId,
          godownId: outLine.props.godownId,
          debit: Money.zero(),
          credit: Money.of(outValue),
          accountType: 'ASSET',
          isControlAccount: false,
        },
      ];
      return {
        companyId,
        financialYearId,
        voucherType: 'STOCK_JOURNAL',
        voucherDate,
        sourceType: STOCK_JOURNAL_SOURCE_TYPE,
        sourceId: journal.id,
        postedBy: actor.userId,
        lines,
      };
    }

    if (outLine && !inLine) {
      // ISSUE / CONSUMPTION — §4.1 Dr material expense / Cr inventory.
      const inventoryAccountId = await this.accounts.inventoryAccountOf(companyId, itemId);
      const expenseAccountId = await this.accounts.expenseAccountOf(companyId);
      const lines: PostingLine[] = [
        {
          accountId: expenseAccountId,
          projectId: outLine.props.projectId,
          costCentreId: outLine.props.costCentreId,
          purposeId: outLine.props.purposeId,
          godownId: outLine.props.godownId,
          debit: Money.of(outValue),
          credit: Money.zero(),
          accountType: 'EXPENSE',
          isControlAccount: false,
        },
        {
          accountId: inventoryAccountId,
          projectId: outLine.props.projectId,
          costCentreId: outLine.props.costCentreId,
          purposeId: outLine.props.purposeId,
          godownId: outLine.props.godownId,
          debit: Money.zero(),
          credit: Money.of(outValue),
          accountType: 'ASSET',
          isControlAccount: false,
        },
      ];
      return {
        companyId,
        financialYearId,
        voucherType: 'STOCK_JOURNAL',
        voucherDate,
        sourceType: STOCK_JOURNAL_SOURCE_TYPE,
        sourceId: journal.id,
        postedBy: actor.userId,
        lines,
      };
    }

    // ADJUSTMENT (single-sided in/out only) — no ledger entry in this brief's scope.
    return null;
  }
}
