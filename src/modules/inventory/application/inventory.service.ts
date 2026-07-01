/**
 * InventoryServiceAdapter (APPLICATION) — implements InventoryService, the ONE seam PUR/REQ use to move
 * stock through INV's mechanics (FR-INV-006). Thin: delegates every valuation computation to brief-1's
 * pure `valuation.ts` (`applyReceipt`/`valueIssue`/`applyTransferIn`) and every write to the brief-1
 * `StockMovementRepository` — the SAME locked `currentBalanceForUpdate` re-roll a Stock Journal post uses
 * (FR-INV-010, design §5.4), so a concurrent `issueOut`/`reverseIssueOut` and a concurrent Stock-Journal
 * post on the same `(godown, item)` serialise through the one lock, not two. Opens NO transaction of its
 * own — the caller's UnitOfWork must already be active when these are called (mirrors
 * `PostStockJournalUseCase`'s per-side movement writes exactly). `reverseIssueOut` (brief #23) mirrors
 * `ReverseStockJournalUseCase`'s OUT-mirror branch exactly: `applyTransferIn(prev, quantity, value)` to
 * restore the precise value that left, then an `IN, isReversal:true` movement. `reverseReceipt` (brief
 * purchase-po-bill-posting) mirrors the IN-mirror branch exactly: `valueIssue(prev, quantity,
 * {allowNegative:true})` to value the undo at the CURRENT source average, then an `OUT, isReversal:true`
 * movement.
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { StockMovement } from '../domain/stock-movement';
import { applyReceipt, applyTransferIn, averageRate, valueIssue } from '../domain/valuation';
import {
  STOCK_MOVEMENT_REPOSITORY,
  StockMovementRepository,
} from '../domain/ports/stock-movement.repository';
import {
  InventoryService,
  IssueOutInput,
  PostCtx,
  ReceiveInInput,
  ReverseIssueOutInput,
  ReverseReceiptInput,
} from '../domain/ports/inventory.service.port';

@Injectable()
export class InventoryServiceAdapter implements InventoryService {
  constructor(
    @Inject(STOCK_MOVEMENT_REPOSITORY) private readonly movements: StockMovementRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async receiveIn(ctx: PostCtx, input: ReceiveInInput): Promise<{ avgRate: Decimal | null }> {
    const prev = await this.movements.currentBalanceForUpdate(ctx.companyId, input.godownId, input.itemId);
    const after = applyReceipt(prev, input.qty, input.rate);
    const movement = StockMovement.create(
      {
        companyId: ctx.companyId,
        godownId: input.godownId,
        itemId: input.itemId,
        sourceType: 'GRN',
        sourceId: input.sourceId,
        direction: 'IN',
        quantity: input.qty,
        rate: input.rate,
        value: input.qty.times(input.rate),
        balanceAfter: after,
        voucherDate: ctx.voucherDate,
        postedBy: ctx.postedBy,
      },
      this.ids.next(),
      this.clock.now(),
    );
    await this.movements.append(movement);
    return { avgRate: averageRate(after) };
  }

  async issueOut(
    ctx: PostCtx,
    input: IssueOutInput,
  ): Promise<{ issuedValue: Decimal; rate: Decimal; movementId: string }> {
    const prev = await this.movements.currentBalanceForUpdate(ctx.companyId, input.godownId, input.itemId);
    const { issuedValue, rate, newBalance } = valueIssue(prev, input.qty, {
      allowNegative: input.allowNegative,
    });
    const movementId = this.ids.next();
    const movement = StockMovement.create(
      {
        companyId: ctx.companyId,
        godownId: input.godownId,
        itemId: input.itemId,
        sourceType: 'REQ_ISSUE',
        sourceId: input.sourceId,
        direction: 'OUT',
        quantity: input.qty,
        rate,
        value: issuedValue,
        balanceAfter: newBalance,
        voucherDate: ctx.voucherDate,
        postedBy: ctx.postedBy,
      },
      movementId,
      this.clock.now(),
    );
    await this.movements.append(movement);
    return { issuedValue, rate, movementId };
  }

  async reverseIssueOut(ctx: PostCtx, input: ReverseIssueOutInput): Promise<void> {
    const prev = await this.movements.currentBalanceForUpdate(ctx.companyId, input.godownId, input.itemId);
    // Restore the EXACT qty/value that left — never re-valued (design §5.3, mirrors
    // ReverseStockJournalUseCase's OUT-mirror branch exactly).
    const restored = applyTransferIn(prev, input.qty, input.value);
    const rate = input.qty.isZero() ? new Decimal(0) : input.value.dividedBy(input.qty);
    const movement = StockMovement.create(
      {
        companyId: ctx.companyId,
        godownId: input.godownId,
        itemId: input.itemId,
        sourceType: 'REQ_ISSUE',
        sourceId: input.sourceId,
        direction: 'IN',
        quantity: input.qty,
        rate,
        value: input.value,
        balanceAfter: restored,
        isReversal: true,
        voucherDate: ctx.voucherDate,
        postedBy: ctx.postedBy,
      },
      this.ids.next(),
      this.clock.now(),
    );
    await this.movements.append(movement);
  }

  async reverseReceipt(ctx: PostCtx, input: ReverseReceiptInput): Promise<void> {
    const prev = await this.movements.currentBalanceForUpdate(ctx.companyId, input.godownId, input.itemId);
    // Value the undo at the CURRENT source average (never the original receipt rate) — mirrors
    // ReverseStockJournalUseCase's IN-mirror branch exactly; allowNegative:true because a reversal must
    // always be able to complete structurally (design doc, InventoryService port).
    const { issuedValue, rate, newBalance } = valueIssue(prev, input.qty, { allowNegative: true });
    const movement = StockMovement.create(
      {
        companyId: ctx.companyId,
        godownId: input.godownId,
        itemId: input.itemId,
        sourceType: 'GRN',
        sourceId: input.sourceId,
        direction: 'OUT',
        quantity: input.qty,
        rate,
        value: issuedValue,
        balanceAfter: newBalance,
        isReversal: true,
        voucherDate: ctx.voucherDate,
        postedBy: ctx.postedBy,
      },
      this.ids.next(),
      this.clock.now(),
    );
    await this.movements.append(movement);
  }
}
