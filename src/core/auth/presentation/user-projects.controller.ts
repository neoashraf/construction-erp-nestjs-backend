/**
 * UserProjectsController (PRESENTATION) — /api/users/:id/projects. Admin only. FR-AUD-014/015/020.
 */
import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Put, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { RequirePermission } from './require-permission.decorator';
import { CurrentActor } from './current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { UsersQueryService } from '../read/users.query-service';
import { UserProjectUseCases } from '../application/rbac.use-cases';

class PutProjectsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  projectIds!: string[];
}

@ApiTags('Users')
@Controller('api/users/:id/projects')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UserProjectsController {
  constructor(
    private readonly query: UsersQueryService,
    private readonly useCases: UserProjectUseCases,
  ) {}

  @Get()
  @RequirePermission('audit.users', 'READ')
  async getProjects(@Param('id') id: string, @CurrentActor() actor: Actor) {
    const result = await this.query.findProjectsForUser(id, actor.companyId);
    if (result === null) throw new NotFoundException('User not found');
    return result;
  }

  @Put()
  @RequirePermission('audit.users', 'UPDATE')
  async replaceProjects(@Param('id') id: string, @Body() dto: PutProjectsDto, @CurrentActor() actor: Actor) {
    await this.useCases.replaceProjects(id, actor, dto.projectIds);
    return this.query.findProjectsForUser(id, actor.companyId);
  }

  @Delete(':projectId')
  @RequirePermission('audit.users', 'UPDATE')
  @HttpCode(204)
  async unassignProject(@Param('id') id: string, @Param('projectId') projectId: string, @CurrentActor() actor: Actor): Promise<void> {
    await this.useCases.unassignProject(id, projectId, actor);
  }
}
