/**
 * AccountGroupController — `/api/masters/account-groups` (FR-MAS-017).
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route `@Roles({module:'MAS', action})`
 * (mas-rbac-guard-wiring, FR-AUD-012/013).
 */
import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { Roles } from '../../../../core/auth/presentation/roles.decorator';
import { Paginated } from '../../../../infrastructure/http/pagination';
import { MasterListQueryDto, VersionBodyDto } from '../../shared/dto';
import { ACCOUNT_TYPES } from '../domain/account-type';
import { CreateAccountGroupUseCase, UpdateAccountGroupUseCase } from '../application/account-group.use-cases';
import { AccountGroupDto, AccountGroupQueryService } from '../read/account-group.query-service';

class CreateAccountGroupDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsUUID() parentGroupId?: string;
  @IsIn(ACCOUNT_TYPES as unknown as string[]) type!: string;
}
class UpdateAccountGroupDto extends VersionBodyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsUUID() parentGroupId?: string;
}
class AccountGroupQueryDto extends MasterListQueryDto {
  @IsOptional() @IsIn(ACCOUNT_TYPES as unknown as string[]) type?: string;
  @IsOptional() @IsUUID() parentGroupId?: string;
}

@ApiTags('Chart of Accounts')
@Controller('api/masters/account-groups')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AccountGroupController {
  constructor(
    private readonly create: CreateAccountGroupUseCase,
    private readonly update: UpdateAccountGroupUseCase,
    private readonly query: AccountGroupQueryService,
  ) {}

  @Get()
  @Roles({ module: 'MAS', action: 'READ' })
  list(@Query() q: AccountGroupQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<AccountGroupDto>> {
    return this.query.list({ page: q.page, pageSize: q.pageSize, type: q.type, parentGroupId: q.parentGroupId }, actor);
  }

  @Post()
  @Roles({ module: 'MAS', action: 'CREATE' })
  create_(@Body() body: CreateAccountGroupDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  @Roles({ module: 'MAS', action: 'UPDATE' })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAccountGroupDto,
    @CurrentActor() actor: Actor,
  ): Promise<AccountGroupDto> {
    await this.update.execute(id, { name: body.name, parentGroupId: body.parentGroupId }, body.version, actor);
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Account group ${id} not found`);
    return dto;
  }
}
