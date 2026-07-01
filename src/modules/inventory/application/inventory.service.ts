/**
 * InventoryServiceAdapter (APPLICATION) — implements InventoryService, the ONE seam PUR/REQ use to move
 * stock through INV's mechanics (FR-INV-006). Thin: delegates every valuation computation to brief-1's
 * pure `valuation.ts` (`applyReceipt`/`valueIssue`) and every write to the brief-1 `StockMovementRepository`
 * — the SAME locked `currentBalanceForUpdate` re-roll a Stock Journal post uses (FR-INV-010, design §5.4),
 * so a concurrent `issueOut` and a concurrent Stock-Journal post on the same `(godown, item)` serialise
 * through the one lock, not two. Opens NO transaction of its own — the caller's UnitOfWork must already be
 * active when these are called (mirrors `PostStockJournalUseCase`'s per-side movement writes exactly).
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { StockMovement } from '../domain/stock-movement';
import { applyReceipt, averageRate, valueIssue } from '../domain/valuation';
import {
  STOCK_MOVEMENT_REPOSITORY,
  StockMovementRepository,
} from '../domain/ports/stock-movement.repository';
import {
  InventoryService,
  IssueOutInput,
  PostCtx,
  ReceiveInInput,
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

  async issueOut(ctx: PostCtx, input: IssueOutInput): Promise<{ issuedValue: Decimal; rate: Decimal }> {
    const prev = await this.movements.currentBalanceForUpdate(ctx.companyId, input.godownId, input.itemId);
    const { issuedValue, rate, newBalance } = valueIssue(prev, input.qty, {
      allowNegative: input.allowNegative,
    });
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
      this.ids.next(),
      this.clock.now(),
    );
    await this.movements.append(movement);
    return { issuedValue, rate };
  }
}
