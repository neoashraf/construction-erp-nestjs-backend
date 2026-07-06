/**
 * RolesController (PRESENTATION) — /api/roles. Admin only (audit.roles resource).
 * GET (list/detail), POST (create custom role), PATCH (rename custom / edit limit+scope),
 * PATCH :id/permissions (atomic batch grid replace), DELETE (custom, blocked if assigned).
 * FR-AUD-011/013/016/019/034/035.
 */
import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { RequirePermission } from './require-permission.decorator';
import { CurrentActor } from './current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { RolesQueryService } from '../read/roles.query-service';
import { RoleUseCases } from '../application/rbac.use-cases';
import { ACTION_CODES, ActionCode, ProjectScope } from '../domain/permission.entity';

class RolePermissionDto {
  @IsString() resource!: string;
  @IsIn(ACTION_CODES as unknown as string[]) action!: ActionCode;
  @IsIn(['ALL', 'ASSIGNED']) projectScope!: ProjectScope;
  @IsOptional() @IsString() valueLimit?: string | null;
}

class CreateRoleDto {
  @IsString() name!: string;
  @IsOptional() @IsBoolean() isUnscoped?: boolean;
  @IsOptional() @IsString() approvalLimit?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RolePermissionDto) permissions?: RolePermissionDto[];
}

class PatchRoleDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() approvalLimit?: string | null;
  @IsOptional() @IsBoolean() isUnscoped?: boolean;
  version!: number;
}

class ReplaceRolePermissionsDto {
  @IsInt() version!: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RolePermissionDto) permissions!: RolePermissionDto[];
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
  @RequirePermission('audit.roles', 'READ')
  async findAll(@CurrentActor() actor: Actor) {
    return this.query.findAll(actor.companyId);
  }

  @Get(':id')
  @RequirePermission('audit.roles', 'READ')
  async findById(@Param('id') id: string, @CurrentActor() actor: Actor) {
    const role = await this.query.findById(id, actor.companyId);
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  @Post()
  @RequirePermission('audit.roles', 'CREATE')
  @HttpCode(201)
  async create(@Body() dto: CreateRoleDto, @CurrentActor() actor: Actor) {
    return this.useCases.createRole(actor, dto);
  }

  @Patch(':id')
  @RequirePermission('audit.roles', 'UPDATE')
  async patch(@Param('id') id: string, @Body() dto: PatchRoleDto, @CurrentActor() actor: Actor) {
    return this.useCases.patchRole(id, actor, dto);
  }

  /** Atomic full-set replace of the role's permission grid (the editor's batch save). FR-AUD-013/019/035. */
  @Patch(':id/permissions')
  @RequirePermission('audit.roles', 'UPDATE')
  async replacePermissions(@Param('id') id: string, @Body() dto: ReplaceRolePermissionsDto, @CurrentActor() actor: Actor) {
    return this.useCases.replaceRolePermissions(id, actor, dto);
  }

  @Delete(':id')
  @RequirePermission('audit.roles', 'DELETE')
  @HttpCode(204)
  async delete(@Param('id') id: string, @CurrentActor() actor: Actor): Promise<void> {
    await this.useCases.deleteRole(id, actor);
  }
}
