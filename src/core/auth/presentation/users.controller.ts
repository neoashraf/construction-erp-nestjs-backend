/**
 * UsersController (PRESENTATION) — /api/users. Admin only. FR-AUD-011/018/019/020.
 */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { RequirePermission } from './require-permission.decorator';
import { CurrentActor } from './current-actor.decorator';
import { Actor } from '../../tenancy/tenant-context';
import { UsersQueryService } from '../read/users.query-service';
import { UserAdminUseCases } from '../application/rbac.use-cases';

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() name!: string;
  @IsUUID() roleId!: string;
  @IsUUID() financialYearId!: string;
  @IsOptional() @IsString() phone?: string;
  @IsString() @MinLength(10) temporaryPassword!: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class PatchUserDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsString() phone?: string;
  version!: number;
}

class ResetPasswordDto {
  @IsString() @MinLength(10) temporaryPassword!: string;
}

@ApiTags('Users')
@Controller('api/users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(
    private readonly query: UsersQueryService,
    private readonly useCases: UserAdminUseCases,
  ) {}

  @Get()
  @RequirePermission('audit.users', 'READ')
  findAll(
    @CurrentActor() actor: Actor,
    @Query('role') role?: string,
    @Query('isActive') isActive?: string,
    @Query('search') search?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.query.findAll(actor.companyId, {
      role,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      search,
      page: +page,
      pageSize: +pageSize,
    });
  }

  @Post()
  @RequirePermission('audit.users', 'CREATE')
  @HttpCode(201)
  create(@Body() dto: CreateUserDto, @CurrentActor() actor: Actor) {
    return this.useCases.createUser(actor, dto);
  }

  @Get(':id')
  @RequirePermission('audit.users', 'READ')
  async findById(@Param('id') id: string, @CurrentActor() actor: Actor) {
    const user = await this.query.findById(id, actor.companyId);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Patch(':id')
  @RequirePermission('audit.users', 'UPDATE')
  patch(@Param('id') id: string, @Body() dto: PatchUserDto, @CurrentActor() actor: Actor) {
    return this.useCases.patchUser(id, actor, dto);
  }

  @Post(':id/activate')
  @RequirePermission('audit.users', 'UPDATE')
  @HttpCode(200)
  activate(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.useCases.activateUser(id, actor);
  }

  @Post(':id/deactivate')
  @RequirePermission('audit.users', 'UPDATE')
  @HttpCode(200)
  deactivate(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.useCases.deactivateUser(id, actor);
  }

  @Post(':id/reset-password')
  @RequirePermission('audit.users', 'UPDATE')
  @HttpCode(204)
  async resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto, @CurrentActor() actor: Actor): Promise<void> {
    await this.useCases.resetPassword(id, actor, dto);
  }
}
