/**
 * StockLedgerController (PRESENTATION) — `/api/stock-journal/stock-ledger` READ-ONLY surface
 * (FR-INV-001/-004/-021). There is NO write endpoint here: a `(godown, item)` balance changes ONLY by
 * appending a stock movement via a posted stock-affecting voucher (brief 2 / brief 3) — never by a
 * direct mutation. Company is implicit from the JWT; project-scoped readers are restricted server-side
 * in the query service. `inventory:read` guard lands with auth-jwt; the actor is resolved via
 * `@CurrentActor`.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Actor } from '../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../core/auth/presentation/current-actor.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { StockLedgerQueryService } from '../application/stock-ledger-query.service';
import {
  StockLedgerRow,
  StockMovementRow,
} from '../domain/ports/stock-balance.read.port';
import { StockLedgerQueryDto, StockMovementsQueryDto } from './stock-ledger-query.dto';

@ApiTags('Stock Ledger')
@Controller('api/stock-journal/stock-ledger')
export class StockLedgerController {
  constructor(private readonly query: StockLedgerQueryService) {}

  @Get()
  stockLedger(
    @Query() q: StockLedgerQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<StockLedgerRow>> {
    return this.query.stockLedger(q, actor);
  }

  @Get('movements')
  movements(
    @Query() q: StockMovementsQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<StockMovementRow>> {
    return this.query.movements(q, actor);
  }
}
