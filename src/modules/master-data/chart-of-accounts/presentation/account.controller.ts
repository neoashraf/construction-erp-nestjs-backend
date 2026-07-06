/**
 * AccountController — `/api/masters/accounts` (FR-MAS-018..021/029/033).
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route `@Roles({module:'MAS', action})`
 * (mas-rbac-guard-wiring, FR-AUD-012/013).
 */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../../core/auth/presentation/require-permission.decorator';
import { Paginated } from '../../../../infrastructure/http/pagination';
import { MasterListQueryDto, VersionBodyDto, parseActive } from '../../shared/dto';
import { ACCOUNT_TYPES } from '../domain/account-type';
import {
  CreateAccountUseCase,
  UpdateAccountUseCase,
  DeactivateAccountUseCase,
  ReactivateAccountUseCase,
} from '../application/account.use-cases';
import { AccountDto, AccountQueryService } from '../read/account.query-service';

class CreateAccountDto {
  @IsString() @MinLength(1) @MaxLength(40) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsUUID() accountGroupId!: string;
  @IsIn(ACCOUNT_TYPES as unknown as string[]) type!: string;
  @IsOptional() @IsNumberString() openingBalance?: string;
}
class UpdateAccountDto extends VersionBodyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsUUID() accountGroupId?: string;
  @IsOptional() @IsIn(ACCOUNT_TYPES as unknown as string[]) type?: string;
  @IsOptional() @IsNumberString() openingBalance?: string;
}
class AccountQueryDto extends MasterListQueryDto {
  @IsOptional() @IsIn(ACCOUNT_TYPES as unknown as string[]) type?: string;
  @IsOptional() @IsUUID() accountGroupId?: string;
}

@ApiTags('Chart of Accounts')
@Controller('api/masters/accounts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AccountController {
  constructor(
    private readonly create: CreateAccountUseCase,
    private readonly update: UpdateAccountUseCase,
    private readonly deactivate: DeactivateAccountUseCase,
    private readonly reactivate: ReactivateAccountUseCase,
    private readonly query: AccountQueryService,
  ) {}

  @Get()
  @RequirePermission('master_data.chart_of_accounts', 'READ')
  list(@Query() q: AccountQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<AccountDto>> {
    return this.query.list(
      { page: q.page, pageSize: q.pageSize, type: q.type, accountGroupId: q.accountGroupId, isActive: parseActive(q.isActive), q: q.q },
      actor,
    );
  }

  @Get(':id')
  @RequirePermission('master_data.chart_of_accounts', 'READ')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<AccountDto> {
    return this.require(id, actor);
  }

  @Post()
  @RequirePermission('master_data.chart_of_accounts', 'CREATE')
  create_(@Body() body: CreateAccountDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  @RequirePermission('master_data.chart_of_accounts', 'UPDATE')
  async patch(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateAccountDto, @CurrentActor() actor: Actor): Promise<AccountDto> {
    await this.update.execute(
      id,
      { name: body.name, accountGroupId: body.accountGroupId, type: body.type, openingBalance: body.openingBalance },
      body.version,
      actor,
    );
    return this.require(id, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermission('master_data.chart_of_accounts', 'UPDATE')
  async deactivate_(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<AccountDto> {
    await this.deactivate.execute(id, body.version, actor);
    return this.require(id, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission('master_data.chart_of_accounts', 'UPDATE')
  async reactivate_(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<AccountDto> {
    await this.reactivate.execute(id, body.version, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<AccountDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Account ${id} not found`);
    return dto;
  }
}
