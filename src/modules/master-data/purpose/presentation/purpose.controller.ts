/**
 * PurposeController — `/api/masters/projects/:projectId/purposes` (FR-MAS-011/012/013/029/033).
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route `@Roles({module:'MAS', action})`
 * (mas-rbac-guard-wiring, FR-AUD-012/013).
 */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../../core/auth/presentation/require-permission.decorator';
import { Paginated } from '../../../../infrastructure/http/pagination';
import { MasterListQueryDto, VersionBodyDto, parseActive } from '../../shared/dto';
import { InlineCreatePurposeUseCase, RenamePurposeUseCase, SetPurposeActiveUseCase } from '../application/purpose.use-cases';
import { PurposeDto, PurposeQueryService } from '../read/purpose.query-service';

class PurposeNameDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
}
class RenamePurposeDto extends VersionBodyDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
}

@ApiTags('Projects')
@Controller('api/masters/projects/:projectId/purposes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PurposeController {
  constructor(
    private readonly inlineCreate: InlineCreatePurposeUseCase,
    private readonly rename: RenamePurposeUseCase,
    private readonly setActive: SetPurposeActiveUseCase,
    private readonly query: PurposeQueryService,
  ) {}

  @Get()
  @RequirePermission('master_data.purposes', 'READ')
  list(@Param('projectId', ParseUUIDPipe) projectId: string, @Query() q: MasterListQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<PurposeDto>> {
    return this.query.listByProject(projectId, { page: q.page, pageSize: q.pageSize, isActive: parseActive(q.isActive), q: q.q }, actor);
  }

  // Idempotent inline-create: 201 on insert, 200 when an existing purpose is returned (edge §12.5).
  @Post()
  @RequirePermission('master_data.purposes', 'CREATE')
  async create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: PurposeNameDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ id: string }> {
    const { id, created } = await this.inlineCreate.execute(projectId, body.name, actor);
    res.status(created ? 201 : 200);
    return { id };
  }

  @Patch(':id')
  @RequirePermission('master_data.purposes', 'UPDATE')
  async patch(@Param('projectId', ParseUUIDPipe) _p: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: RenamePurposeDto, @CurrentActor() actor: Actor): Promise<PurposeDto> {
    await this.rename.execute(id, body.name, body.version, actor);
    return this.require(id, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermission('master_data.purposes', 'UPDATE')
  async deactivate(@Param('projectId', ParseUUIDPipe) _p: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<PurposeDto> {
    await this.setActive.execute(id, body.version, false, actor);
    return this.require(id, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission('master_data.purposes', 'UPDATE')
  async reactivate(@Param('projectId', ParseUUIDPipe) _p: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<PurposeDto> {
    await this.setActive.execute(id, body.version, true, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<PurposeDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Purpose ${id} not found`);
    return dto;
  }
}
