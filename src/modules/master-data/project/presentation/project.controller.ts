/** ProjectController — `/api/masters/projects` (FR-MAS-005/006). */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { Paginated } from '../../../../infrastructure/http/pagination';
import { CreateProjectUseCase, UpdateProjectUseCase, ChangeProjectStatusUseCase } from '../application/project.use-cases';
import { ProjectDto, ProjectQueryService } from '../read/project.query-service';
import { ProjectStatusAction } from '../domain/project';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

class CreateProjectDto {
  @IsString() @MinLength(1) @MaxLength(40) projectCode!: string;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) location?: string;
  @IsUUID() customerId!: string;
  @IsUUID() projectManagerId!: string;
  @Matches(ISO) startDate!: string;
  @Matches(ISO) expectedEndDate!: string;
}
class UpdateProjectDto {
  @IsOptional() @IsString() @MaxLength(40) projectCode?: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) location?: string | null;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsUUID() projectManagerId?: string;
  @IsOptional() @Matches(ISO) expectedEndDate?: string;
  @IsInt() @Min(1) version!: number;
}
class StatusDto {
  @IsIn(['activate', 'hold', 'resume', 'close', 'reopen']) action!: ProjectStatusAction;
  @IsInt() @Min(1) version!: number;
}
class ListProjectsQueryDto {
  @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : Number(value))) @IsInt() @Min(1) page?: number;
  @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : Number(value))) @IsInt() @Min(1) pageSize?: number;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsUUID() projectManagerId?: string;
  @IsOptional() @IsString() q?: string;
}

@ApiTags('Projects')
@Controller('api/masters/projects')
export class ProjectController {
  constructor(
    private readonly create: CreateProjectUseCase,
    private readonly update: UpdateProjectUseCase,
    private readonly changeStatus: ChangeProjectStatusUseCase,
    private readonly query: ProjectQueryService,
  ) {}

  @Get()
  list(@Query() q: ListProjectsQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<ProjectDto>> {
    return this.query.list(q, actor);
  }

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<ProjectDto> {
    return this.require(id, actor);
  }

  @Post()
  create_(@Body() body: CreateProjectDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  async patch(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProjectDto, @CurrentActor() actor: Actor): Promise<ProjectDto> {
    const { version, ...changes } = body;
    await this.update.execute(id, changes, version, actor);
    return this.require(id, actor);
  }

  @Post(':id/status')
  @HttpCode(200)
  async status(@Param('id', ParseUUIDPipe) id: string, @Body() body: StatusDto, @CurrentActor() actor: Actor): Promise<ProjectDto> {
    await this.changeStatus.execute(id, body.action, body.version, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<ProjectDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Project ${id} not found`);
    return dto;
  }
}
