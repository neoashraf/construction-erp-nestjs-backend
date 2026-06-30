/**
 * LedgerController (PRESENTATION) — `/api/ledger` READ-ONLY surface (FR-LED-030/031). The ledger has
 * NO HTTP write endpoint — posting/reversing is an internal PostingService call inside a voucher's
 * transaction. Company implicit from JWT; PM project-scope applied in the query service. `ledger:read`
 * guard lands with auth-jwt; the actor is resolved via `@CurrentActor`.
 */
import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Actor } from '../../tenancy/tenant-context';
import { CurrentActor } from '../../auth/presentation/current-actor.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import {
  LedgerEntryDetailDto,
  LedgerEntryHeaderDto,
  LedgerLineDto,
  LedgerQueryService,
  TrialBalanceRow,
} from '../read/ledger-query.service';
import {
  EntriesQueryDto,
  LinesQueryDto,
  TrialBalanceQueryDto,
} from '../read/dto/ledger-query.dto';

@ApiTags('Ledger')
@Controller('api/ledger')
export class LedgerController {
  constructor(private readonly query: LedgerQueryService) {}

  @Get('entries')
  entries(
    @Query() q: EntriesQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<LedgerEntryHeaderDto>> {
    return this.query.entries(q, actor);
  }

  @Get('entries/:id')
  async entryById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<LedgerEntryDetailDto> {
    const dto = await this.query.entryById(id, actor);
    if (!dto) throw new NotFoundException(`Journal entry ${id} not found`);
    return dto;
  }

  @Get('lines')
  lines(@Query() q: LinesQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<LedgerLineDto>> {
    return this.query.lines(q, actor);
  }

  @Get('trial-balance')
  trialBalance(
    @Query() q: TrialBalanceQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<TrialBalanceRow>> {
    return this.query.trialBalance(q, actor);
  }
}
