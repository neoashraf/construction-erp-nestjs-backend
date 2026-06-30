/** AccountGroupController — `/api/masters/account-groups` (FR-MAS-017). Admin (guards via auth-jwt). */
import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
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

@Controller('api/masters/account-groups')
export class AccountGroupController {
  constructor(
    private readonly create: CreateAccountGroupUseCase,
    private readonly update: UpdateAccountGroupUseCase,
    private readonly query: AccountGroupQueryService,
  ) {}

  @Get()
  list(@Query() q: AccountGroupQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<AccountGroupDto>> {
    return this.query.list({ page: q.page, pageSize: q.pageSize, type: q.type, parentGroupId: q.parentGroupId }, actor);
  }

  @Post()
  create_(@Body() body: CreateAccountGroupDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
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
