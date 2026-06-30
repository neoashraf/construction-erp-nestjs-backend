/**
 * FinancialYearController (PRESENTATION) — `/api/masters/financial-years` (FR-MAS-002, FR-MAS-003).
 * Thin: resolve the actor, delegate, map. Company comes from the actor. Auth/role guards land with the
 * `auth-jwt` brief.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { CreateFinancialYearUseCase } from '../../application/financial-year/create-financial-year.use-case';
import { UpdateFinancialYearUseCase } from '../../application/financial-year/update-financial-year.use-case';
import { SetActiveFinancialYearUseCase } from '../../application/financial-year/set-active-financial-year.use-case';
import { FinancialYearDto, FinancialYearQueryService } from '../read/financial-year.query-service';
import { Paginated } from '../../../../infrastructure/http/pagination';
import {
  CreateFinancialYearDto,
  ListFinancialYearsQueryDto,
  UpdateFinancialYearDto,
} from './dto/financial-year.dto';

@ApiTags('Org')
@Controller('api/masters/financial-years')
export class FinancialYearController {
  constructor(
    private readonly createFy: CreateFinancialYearUseCase,
    private readonly updateFy: UpdateFinancialYearUseCase,
    private readonly setActiveFy: SetActiveFinancialYearUseCase,
    private readonly query: FinancialYearQueryService,
  ) {}

  @Get()
  list(
    @Query() q: ListFinancialYearsQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<FinancialYearDto>> {
    const isActive = q.isActive === undefined ? undefined : q.isActive === 'true';
    return this.query.list({ page: q.page, pageSize: q.pageSize, isActive }, actor);
  }

  @Post()
  create(
    @Body() body: CreateFinancialYearDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ id: string }> {
    return this.createFy.execute(body, actor);
  }

  @Patch(':id')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateFinancialYearDto,
    @CurrentActor() actor: Actor,
  ): Promise<FinancialYearDto> {
    const { version, ...changes } = body;
    await this.updateFy.execute(id, changes, version, actor);
    return this.requireById(id, actor);
  }

  @Post(':id/set-active')
  @HttpCode(200)
  async setActive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<FinancialYearDto> {
    await this.setActiveFy.execute(id, actor);
    return this.requireById(id, actor);
  }

  private async requireById(id: string, actor: Actor): Promise<FinancialYearDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Financial year ${id} not found`);
    return dto;
  }
}
