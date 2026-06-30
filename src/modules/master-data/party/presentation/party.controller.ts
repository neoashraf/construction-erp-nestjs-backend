/** PartyController — `/api/masters/parties` (FR-MAS-022/023/024/029/033). Admin/Accounts (guards via auth-jwt). */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsBooleanString, IsEmail, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { Paginated } from '../../../../infrastructure/http/pagination';
import { MasterListQueryDto, VersionBodyDto, parseActive } from '../../shared/dto';
import {
  CreatePartyUseCase,
  UpdatePartyUseCase,
  DeactivatePartyUseCase,
  ReactivatePartyUseCase,
} from '../application/party.use-cases';
import { PartyDto, PartyQueryService } from '../read/party.query-service';

class CreatePartyDto {
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsBoolean() isCustomer?: boolean;
  @IsOptional() @IsBoolean() isSupplier?: boolean;
  @IsOptional() @IsString() tin?: string;
  @IsOptional() @IsString() bin?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsString() phone!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsInt() @Min(0) paymentTermsDays?: number;
  @IsOptional() @IsString() openingBalance?: string;
}
class UpdatePartyDto extends VersionBodyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;
  @IsOptional() @IsBoolean() isCustomer?: boolean;
  @IsOptional() @IsBoolean() isSupplier?: boolean;
  @IsOptional() @IsString() tin?: string;
  @IsOptional() @IsString() bin?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsInt() @Min(0) paymentTermsDays?: number;
  @IsOptional() @IsString() openingBalance?: string;
}
class PartyQueryDto extends MasterListQueryDto {
  @IsOptional() @IsBooleanString() isCustomer?: string;
  @IsOptional() @IsBooleanString() isSupplier?: string;
}

@ApiTags('Parties')
@Controller('api/masters/parties')
export class PartyController {
  constructor(
    private readonly create: CreatePartyUseCase,
    private readonly update: UpdatePartyUseCase,
    private readonly deactivate: DeactivatePartyUseCase,
    private readonly reactivate: ReactivatePartyUseCase,
    private readonly query: PartyQueryService,
  ) {}

  @Get()
  list(@Query() q: PartyQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<PartyDto>> {
    return this.query.list(
      {
        page: q.page,
        pageSize: q.pageSize,
        isCustomer: parseActive(q.isCustomer),
        isSupplier: parseActive(q.isSupplier),
        isActive: parseActive(q.isActive),
        q: q.q,
      },
      actor,
    );
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<PartyDto> {
    return this.require(id, actor);
  }

  @Post()
  create_(@Body() body: CreatePartyDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  async patch(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdatePartyDto, @CurrentActor() actor: Actor): Promise<PartyDto> {
    const { version, ...rest } = body;
    await this.update.execute(id, rest, version, actor);
    return this.require(id, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  async deactivate_(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<PartyDto> {
    await this.deactivate.execute(id, body.version, actor);
    return this.require(id, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  async reactivate_(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<PartyDto> {
    await this.reactivate.execute(id, body.version, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<PartyDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Party ${id} not found`);
    return dto;
  }
}
