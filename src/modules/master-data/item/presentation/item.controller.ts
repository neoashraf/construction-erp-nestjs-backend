/** ItemController — `/api/masters/items` (+ uom-conversions sub-resource) (FR-MAS-025/026/027/034/029/033). */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { IsNumberString, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { Paginated } from '../../../../infrastructure/http/pagination';
import { MasterListQueryDto, VersionBodyDto, parseActive } from '../../shared/dto';
import {
  CreateItemUseCase,
  UpdateItemUseCase,
  DeactivateItemUseCase,
  ReactivateItemUseCase,
  UpsertItemUomConversionUseCase,
  DeleteItemUomConversionUseCase,
} from '../application/item.use-cases';
import { ItemDto, ItemUomConversionDto, ItemQueryService } from '../read/item.query-service';

class CreateItemDto {
  @IsString() @MinLength(1) @MaxLength(40) code!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsString() @MinLength(1) @MaxLength(20) baseUom!: string;
  @IsOptional() @IsString() @MaxLength(20) hsCode?: string;
  @IsUUID() defaultAccountId!: string;
}
class UpdateItemDto extends VersionBodyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(20) baseUom?: string;
  @IsOptional() @IsString() @MaxLength(20) hsCode?: string;
  @IsOptional() @IsUUID() defaultAccountId?: string;
}
class UpsertUomConversionDto {
  @IsString() @MinLength(1) @MaxLength(20) uom!: string;
  @IsNumberString() factorToBase!: string;
}

@Controller('api/masters/items')
export class ItemController {
  constructor(
    private readonly create: CreateItemUseCase,
    private readonly update: UpdateItemUseCase,
    private readonly deactivate: DeactivateItemUseCase,
    private readonly reactivate: ReactivateItemUseCase,
    private readonly upsertConversion: UpsertItemUomConversionUseCase,
    private readonly deleteConversion: DeleteItemUomConversionUseCase,
    private readonly query: ItemQueryService,
  ) {}

  @Get()
  list(@Query() q: MasterListQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<ItemDto>> {
    return this.query.list({ page: q.page, pageSize: q.pageSize, isActive: parseActive(q.isActive), q: q.q }, actor);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<ItemDto> {
    return this.require(id, actor);
  }

  @Post()
  create_(@Body() body: CreateItemDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  async patch(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateItemDto, @CurrentActor() actor: Actor): Promise<ItemDto> {
    const { version, ...rest } = body;
    await this.update.execute(id, rest, version, actor);
    return this.require(id, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  async deactivate_(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<ItemDto> {
    await this.deactivate.execute(id, body.version, actor);
    return this.require(id, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  async reactivate_(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionBodyDto, @CurrentActor() actor: Actor): Promise<ItemDto> {
    await this.reactivate.execute(id, body.version, actor);
    return this.require(id, actor);
  }

  // --- UoM conversions sub-resource (FR-MAS-026) ---

  @Get(':itemId/uom-conversions')
  async listConversions(@Param('itemId', ParseUUIDPipe) itemId: string, @CurrentActor() actor: Actor): Promise<ItemUomConversionDto[]> {
    await this.require(itemId, actor);
    return this.query.listConversions(itemId, actor);
  }

  @Put(':itemId/uom-conversions')
  @HttpCode(200)
  async upsertConversion_(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: UpsertUomConversionDto,
    @CurrentActor() actor: Actor,
  ): Promise<ItemUomConversionDto> {
    const { id } = await this.upsertConversion.execute(itemId, body, actor);
    const dto = await this.query.getConversion(id, itemId, actor);
    if (!dto) throw new NotFoundException(`UoM conversion ${id} not found`);
    return dto;
  }

  @Delete(':itemId/uom-conversions/:id')
  @HttpCode(204)
  deleteConversion_(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    return this.deleteConversion.execute(itemId, id, actor);
  }

  private async require(id: string, actor: Actor): Promise<ItemDto> {
    const dto = await this.query.getById(id, actor);
    if (!dto) throw new NotFoundException(`Item ${id} not found`);
    return dto;
  }
}
