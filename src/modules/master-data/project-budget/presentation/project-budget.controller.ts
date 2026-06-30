/** ProjectBudgetController — `/api/masters/projects/:projectId/budgets` (FR-MAS-007/008). */
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Min } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { Paginated } from '../../../../infrastructure/http/pagination';
import { UpsertProjectBudgetUseCase, DeleteProjectBudgetUseCase } from '../application/project-budget.use-cases';
import { ProjectBudgetDto, ProjectBudgetQueryService } from '../read/project-budget.query-service';

class UpsertBudgetDto {
  @IsUUID() costCentreId!: string;
  @Matches(/^\d+(\.\d{1,4})?$/, { message: 'budgetedAmount must be a Decimal(18,4) string' }) budgetedAmount!: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
}
class PagingQueryDto {
  @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : Number(value))) @IsInt() @Min(1) page?: number;
  @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : Number(value))) @IsInt() @Min(1) pageSize?: number;
}

@Controller('api/masters/projects/:projectId/budgets')
export class ProjectBudgetController {
  constructor(
    private readonly upsert: UpsertProjectBudgetUseCase,
    private readonly remove: DeleteProjectBudgetUseCase,
    private readonly query: ProjectBudgetQueryService,
  ) {}

  @Get()
  list(@Param('projectId', ParseUUIDPipe) projectId: string, @Query() q: PagingQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<ProjectBudgetDto>> {
    return this.query.listByProject(projectId, q, actor);
  }

  @Put()
  @HttpCode(200)
  upsert_(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: UpsertBudgetDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.upsert.execute(projectId, body, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete_(@Param('projectId', ParseUUIDPipe) _projectId: string, @Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    await this.remove.execute(id, actor);
  }
}
