/**
 * PermissionsController (PRESENTATION) — /api/permissions. Admin only. FR-AUD-012/013/016/019/020.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';
import { CurrentActor } from './current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { PermissionsQueryService } from '../read/permissions.query-service';
import { PermissionUseCases } from '../application/rbac.use-cases';
import { MODULE_CODES, ACTION_CODES, ModuleCode, ActionCode, ProjectScope } from '../domain/permission.entity';

class CreatePermissionDto {
  @IsUUID() roleId!: string;
  @IsIn(MODULE_CODES as unknown as string[]) module!: ModuleCode;
  @IsIn(ACTION_CODES as unknown as string[]) action!: ActionCode;
  @IsIn(['ALL', 'ASSIGNED']) projectScope!: ProjectScope;
  @IsOptional() @IsString() valueLimit?: string | null;
}

class PatchPermissionDto {
  @IsOptional() @IsIn(['ALL', 'ASSIGNED']) projectScope?: ProjectScope;
  @IsOptional() @IsString() valueLimit?: string | null;
  version!: number;
}

@ApiTags('Permissions')
@Controller('api/permissions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PermissionsController {
  constructor(
    private readonly query: PermissionsQueryService,
    private readonly useCases: PermissionUseCases,
  ) {}

  @Get()
  @Roles({ module: 'AUD', action: 'READ' })
  findAll(
    @CurrentActor() actor: Actor,
    @Query('roleId') roleId?: string,
    @Query('module') module?: string,
    @Query('action') action?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.query.findAll(actor.companyId, {
      roleId, module, action, page: +page, pageSize: +pageSize,
    });
  }

  @Post()
  @Roles({ module: 'AUD', action: 'CREATE' })
  @HttpCode(201)
  create(@Body() dto: CreatePermissionDto, @CurrentActor() actor: Actor) {
    return this.useCases.createPermission(actor, dto);
  }

  @Patch(':id')
  @Roles({ module: 'AUD', action: 'UPDATE' })
  patch(@Param('id') id: string, @Body() dto: PatchPermissionDto, @CurrentActor() actor: Actor) {
    return this.useCases.patchPermission(id, actor, dto);
  }

  @Delete(':id')
  @Roles({ module: 'AUD', action: 'DELETE' })
  @HttpCode(204)
  async delete(@Param('id') id: string, @CurrentActor() actor: Actor): Promise<void> {
    await this.useCases.deletePermission(id, actor);
  }
}
