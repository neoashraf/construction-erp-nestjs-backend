/**
 * NumberingAdminController (PRESENTATION) — `/api/masters/numbering-series`. Admin config + read-only
 * state/preview/gap-audit. There is deliberately NO allocate/reserve/consume endpoint — allocation is
 * internal to the post transaction via the NumberingService port (FR-NUM-007/008). Guards:
 * `@UseGuards(JwtAuthGuard, RolesGuard)` at class level + `@Roles({module:'NUM', action})` per route
 * (list/:id/next-preview/gap-audit -> READ, create -> CREATE, patch -> UPDATE), mirroring
 * `period.controller.ts` (per-fy-lock-error) — FR-AUD-012/013/017. The actor is resolved via
 * `@CurrentActor`.
 */
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Actor } from '../../tenancy/tenant-context';
import { CurrentActor } from '../../auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/roles.guard';
import { Roles } from '../../auth/presentation/roles.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { CreateNumberingSeriesUseCase } from '../application/create-numbering-series.use-case';
import { UpdateNumberingSeriesUseCase } from '../application/update-numbering-series.use-case';
import {
  GapAuditDto,
  NextPreviewDto,
  NumberingSeriesDto,
  NumberingSeriesReadService,
} from '../read/numbering-series.read-service';
import {
  CreateNumberingSeriesDto,
  ListNumberingSeriesQueryDto,
  UpdateNumberingSeriesDto,
} from './dto/numbering-series.dto';

@ApiTags('Numbering')
@Controller('api/masters/numbering-series')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NumberingAdminController {
  constructor(
    private readonly createSeries: CreateNumberingSeriesUseCase,
    private readonly updateSeries: UpdateNumberingSeriesUseCase,
    private readonly query: NumberingSeriesReadService,
  ) {}

  @Get()
  @Roles({ module: 'NUM', action: 'READ' })
  list(
    @Query() q: ListNumberingSeriesQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<NumberingSeriesDto>> {
    return this.query.list(q, actor);
  }

  @Post()
  @Roles({ module: 'NUM', action: 'CREATE' })
  create(
    @Body() body: CreateNumberingSeriesDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ id: string }> {
    return this.createSeries.execute(body, actor);
  }

  @Get(':id')
  @Roles({ module: 'NUM', action: 'READ' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<NumberingSeriesDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Numbering series ${id} not found`);
    return dto;
  }

  @Patch(':id')
  @Roles({ module: 'NUM', action: 'UPDATE' })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateNumberingSeriesDto,
    @CurrentActor() actor: Actor,
  ): Promise<NumberingSeriesDto> {
    await this.updateSeries.execute(id, body, actor);
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Numbering series ${id} not found`);
    return dto;
  }

  @Get(':id/next-preview')
  @Roles({ module: 'NUM', action: 'READ' })
  nextPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<NextPreviewDto> {
    return this.query.nextPreview(id, actor);
  }

  @Get(':id/gap-audit')
  @Roles({ module: 'NUM', action: 'READ' })
  gapAudit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<GapAuditDto> {
    return this.query.gapAudit(id, actor);
  }
}
