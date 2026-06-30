/** GodownController — `/api/masters/godowns` (FR-MAS-014/016/029/033). */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { Paginated } from '../../../../infrastructure/http/pagination';
import { VersionBodyDto, parseActive } from '../../shared/dto';
import { CreateGodownUseCase, UpdateGodownUseCase, SetGodownActiveUseCase } from '../application/godown.use-cases';
import { GodownDto, GodownQueryService } from '../read/godown.query-service';

class CreateGodownDto {
  @IsUUID() projectId!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) location?: string;
}
class UpdateGodownDto extends VersionBodyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) location?: string | null;
}
class ListGodownsQueryDto {
  @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : Number(value))) @IsInt() @Min(1) page?: number;
  @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : Number(value))) @IsInt() @Min(1) pageSize?: number;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsString() isActive?: string;
  @IsOptional() @IsString() q?: string;
}

@Controller('api/masters/godowns')
export class GodownController {
  constructor(
    private readonly create: CreateGodownUseCase,
    private readonly update: UpdateGodownUseCase,
    private readonly setActive: SetGodownActiveUseCase,
    private readonly query: GodownQueryService,
  ) {}

  @Get()
  list(@Query() q: ListGodownsQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<GodownDto>> {
    return this.query.list({ page: q.page, pageSize: q.pageSize, projectId: q.projectId, isActive: parseActive(q.isActive), q: q.q }, actor);
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<GodownDto> {
    return this.require(id, actor);
  }

  @Post()
  create_(@Body() body: CreateGodownDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  async patch(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateGodownDto, @CurrentActor() actor: Actor): Promise<GodownDto> {
    const { version, ...changes } = body;
    await this.update.execute(id, changes, version, actor);
    return this.require(id, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  async deactivate(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<GodownDto> {
    await this.setActive.execute(id, body.version, false, actor);
    return this.require(id, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  async reactivate(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<GodownDto> {
    await this.setActive.execute(id, body.version, true, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<GodownDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Godown ${id} not found`);
    return dto;
  }
}
