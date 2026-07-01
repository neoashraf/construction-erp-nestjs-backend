/**
 * CostCentreController — `/api/masters/cost-centres` (FR-MAS-009/010/029/033).
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route `@Roles({module:'MAS', action})`
 * (mas-rbac-guard-wiring, FR-AUD-012/013).
 */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { Roles } from '../../../../core/auth/presentation/roles.decorator';
import { Paginated } from '../../../../infrastructure/http/pagination';
import { MasterListQueryDto, VersionBodyDto, parseActive } from '../../shared/dto';
import { CreateCostCentreUseCase, RenameCostCentreUseCase, DeactivateCostCentreUseCase, ReactivateCostCentreUseCase } from '../application/cost-centre.use-cases';
import { CostCentreDto, CostCentreQueryService } from '../read/cost-centre.query-service';

class CreateCostCentreDto {
  @IsString() @MinLength(1) @MaxLength(40) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
}
class RenameCostCentreDto extends VersionBodyDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
}

@ApiTags('Dimensions')
@Controller('api/masters/cost-centres')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CostCentreController {
  constructor(
    private readonly create: CreateCostCentreUseCase,
    private readonly rename: RenameCostCentreUseCase,
    private readonly deactivate: DeactivateCostCentreUseCase,
    private readonly reactivate: ReactivateCostCentreUseCase,
    private readonly query: CostCentreQueryService,
  ) {}

  @Get()
  @Roles({ module: 'MAS', action: 'READ' })
  list(@Query() q: MasterListQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<CostCentreDto>> {
    return this.query.list({ page: q.page, pageSize: q.pageSize, isActive: parseActive(q.isActive), q: q.q }, actor);
  }

  @Post()
  @Roles({ module: 'MAS', action: 'CREATE' })
  create_(@Body() body: CreateCostCentreDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  @Roles({ module: 'MAS', action: 'UPDATE' })
  async patch(@Param('id', ParseUUIDPipe) id: string, @Body() body: RenameCostCentreDto, @CurrentActor() actor: Actor): Promise<CostCentreDto> {
    await this.rename.execute(id, body.name, body.version, actor);
    return this.require(id, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @Roles({ module: 'MAS', action: 'UPDATE' })
  async deactivate_(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<CostCentreDto> {
    await this.deactivate.execute(id, body.version, actor);
    return this.require(id, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @Roles({ module: 'MAS', action: 'UPDATE' })
  async reactivate_(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<CostCentreDto> {
    await this.reactivate.execute(id, body.version, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<CostCentreDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Cost centre ${id} not found`);
    return dto;
  }
}
