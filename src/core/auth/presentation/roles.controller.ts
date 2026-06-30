/**
 * RolesController (PRESENTATION) — GET /api/roles, PATCH /api/roles/:id.
 * Admin only: requires AUD READ (list/detail) and AUD UPDATE (patch). FR-AUD-011/016/019.
 */
import { Body, Controller, Get, NotFoundException, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';
import { CurrentActor } from './current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { RolesQueryService } from '../read/roles.query-service';
import { RoleUseCases } from '../application/rbac.use-cases';

class PatchRoleDto {
  @IsOptional()
  @IsString()
  approvalLimit?: string | null;
  @IsOptional()
  @IsBoolean()
  isUnscoped?: boolean;
  version!: number;
}

@ApiTags('Roles')
@Controller('api/roles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RolesController {
  constructor(
    private readonly query: RolesQueryService,
    private readonly useCases: RoleUseCases,
  ) {}

  @Get()
  @Roles({ module: 'AUD', action: 'READ' })
  async findAll(@CurrentActor() actor: Actor) {
    return this.query.findAll(actor.companyId);
  }

  @Get(':id')
  @Roles({ module: 'AUD', action: 'READ' })
  async findById(@Param('id') id: string, @CurrentActor() actor: Actor) {
    const role = await this.query.findById(id, actor.companyId);
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  @Patch(':id')
  @Roles({ module: 'AUD', action: 'UPDATE' })
  async patch(@Param('id') id: string, @Body() dto: PatchRoleDto, @CurrentActor() actor: Actor) {
    return this.useCases.patchRole(id, actor, dto);
  }
}
