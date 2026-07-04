/**
 * PeriodController (PRESENTATION) — `/api/periods` (FR-PER-001..010). Generate / list / get / resolve
 * and the close · reopen · close-fy lifecycle transitions. Company implicit from the JWT.
 * Role guards: `@RequirePermission('periods', 'UPDATE')` on every state-mutating route
 * (`generate` / `close` / `reopen` / `close-fy`) — a caller lacking it is rejected `FORBIDDEN` (403)
 * BEFORE the use case runs any existence/state/year-lock check (evaluation order, per-fy-lock-error
 * brief §3). Read routes stay open to any authenticated user. The post-time guard is NOT here — it's
 * invoked by PostingService (LED).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Actor } from '../../tenancy/tenant-context';
import { CurrentActor } from '../../auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/roles.guard';
import { RequirePermission } from '../../auth/presentation/require-permission.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { GeneratePeriodsUseCase } from '../application/generate-periods.use-case';
import { ClosePeriodUseCase } from '../application/close-period.use-case';
import { ReopenPeriodUseCase } from '../application/reopen-period.use-case';
import { CloseFyUseCase } from '../application/close-fy.use-case';
import { PeriodQueryService, ResolveResult } from '../read/period-query.service';
import { AccountingPeriodDto, toPeriodDto } from '../read/period.dto';
import {
  CloseFyDto,
  GeneratePeriodsDto,
  ListPeriodsQueryDto,
  ResolvePeriodQueryDto,
} from './dto/period.dto';

@ApiTags('Periods')
@Controller('api/periods')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PeriodController {
  constructor(
    private readonly generate: GeneratePeriodsUseCase,
    private readonly closePeriod: ClosePeriodUseCase,
    private readonly reopenPeriod: ReopenPeriodUseCase,
    private readonly closeFy: CloseFyUseCase,
    private readonly query: PeriodQueryService,
  ) {}

  @Get()
  list(
    @Query() q: ListPeriodsQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<AccountingPeriodDto>> {
    return this.query.list(q, actor);
  }

  @Post('generate')
  @RequirePermission('periods', 'UPDATE')
  async generatePeriods(
    @Body() body: GeneratePeriodsDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ financialYearId: string; count: number; periods: AccountingPeriodDto[] }> {
    const periods = await this.generate.execute(body.financialYearId, actor);
    return { financialYearId: body.financialYearId, count: periods.length, periods: periods.map(toPeriodDto) };
  }

  // NOTE: 'resolve' is declared BEFORE ':id' so the static route wins over the param route.
  @Get('resolve')
  resolve(@Query() q: ResolvePeriodQueryDto, @CurrentActor() actor: Actor): Promise<ResolveResult> {
    return this.query.resolve(q.financialYearId, q.date, actor);
  }

  @Post('close-fy')
  @HttpCode(200)
  @RequirePermission('periods', 'UPDATE')
  async closeFinancialYear(
    @Body() body: CloseFyDto,
    @CurrentActor() actor: Actor,
  ): Promise<{
    financialYearId: string;
    closedCount: number;
    alreadyClosedCount: number;
    periods: AccountingPeriodDto[];
  }> {
    const result = await this.closeFy.execute(body.financialYearId, actor);
    return {
      financialYearId: body.financialYearId,
      closedCount: result.closedCount,
      alreadyClosedCount: result.alreadyClosedCount,
      periods: result.periods.map(toPeriodDto),
    };
  }

  @Get(':id')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<AccountingPeriodDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Accounting period ${id} not found`);
    return dto;
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission('periods', 'UPDATE')
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<AccountingPeriodDto> {
    return toPeriodDto(await this.closePeriod.execute(id, actor));
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermission('periods', 'UPDATE')
  async reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<AccountingPeriodDto> {
    return toPeriodDto(await this.reopenPeriod.execute(id, actor));
  }
}
