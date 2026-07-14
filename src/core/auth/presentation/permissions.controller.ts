/**
 * PermissionsController (PRESENTATION) — /api/permissions. Admin only (audit.roles resource).
 * GET /catalog (Resource Catalogue), GET (list), POST/PATCH/DELETE grants. FR-AUD-012/013/016/019/020/035.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { RequirePermission } from './require-permission.decorator';
import { CurrentActor } from './current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { PermissionsQueryService } from '../read/permissions.query-service';
import { PermissionUseCases } from '../application/rbac.use-cases';
import { ACTION_CODES, ActionCode, ProjectScope } from '../domain/permission.entity';

class CreatePermissionDto {
  @IsUUID() roleId!: string;
  @IsString() resource!: string;
  @IsIn(ACTION_CODES as unknown as string[]) action!: ActionCode;
  @IsIn(['ALL', 'ASSIGNED']) projectScope!: ProjectScope;
  @IsOptional() @IsString() valueLimit?: string | null;
}

class PatchPermissionDto {
  @IsOptional() @IsIn(['ALL', 'ASSIGNED']) projectScope?: ProjectScope;
  @IsOptional() @IsString() valueLimit?: string | null;
  // @IsInt() required: the whitelist+forbidNonWhitelisted ValidationPipe rejects any
  // property with no validation decorator ("property version should not exist").
  @IsInt() version!: number;
}

@ApiTags('Permissions')
@Controller('api/permissions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PermissionsController {
  constructor(
    private readonly query: PermissionsQueryService,
    private readonly useCases: PermissionUseCases,
  ) {}

  @Get('catalog')
  @RequirePermission('audit.roles', 'READ')
  catalog() {
    return this.query.catalog();
  }

  @Get()
  @RequirePermission('audit.roles', 'READ')
  findAll(
    @CurrentActor() actor: Actor,
    @Query('roleId') roleId?: string,
    @Query('resource') resource?: string,
    @Query('action') action?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.query.findAll(actor.companyId, {
      roleId, resource, action, page: +page, pageSize: +pageSize,
    });
  }

  @Post()
  @RequirePermission('audit.roles', 'CREATE')
  @HttpCode(201)
  create(@Body() dto: CreatePermissionDto, @CurrentActor() actor: Actor) {
    return this.useCases.createPermission(actor, dto);
  }

  @Patch(':id')
  @RequirePermission('audit.roles', 'UPDATE')
  patch(@Param('id') id: string, @Body() dto: PatchPermissionDto, @CurrentActor() actor: Actor) {
    return this.useCases.patchPermission(id, actor, dto);
  }

  @Delete(':id')
  @RequirePermission('audit.roles', 'DELETE')
  @HttpCode(204)
  async delete(@Param('id') id: string, @CurrentActor() actor: Actor): Promise<void> {
    await this.useCases.deletePermission(id, actor);
  }
}
