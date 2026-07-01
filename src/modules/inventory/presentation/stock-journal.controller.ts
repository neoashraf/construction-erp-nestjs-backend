/**
 * StockJournalController — `/api/stock-journal` (FR-INV-007..022). The Stock Journal voucher lifecycle:
 * create (DRAFT) · list/read · PATCH/DELETE (DRAFT only) · approve · post · reverse. camelCase JSON +
 * `{data,meta}` envelope (interceptor) + canonical/module error codes (filter). No RBAC guards on this
 * controller — matches the established Tier-2 convention (contra-journal, sales, requisition controllers
 * carry none yet; architectural decision 2). The actor (company implicit) is resolved via @CurrentActor.
 * Money/qty are numeric(18,4) strings; dates 'YYYY-MM-DD'.
 */
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
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Actor } from '../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../core/auth/presentation/current-actor.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { STOCK_JOURNAL_MODES } from '../domain/stock-journal-mode';
import { CreateStockJournalUseCase } from '../application/create-stock-journal.usecase';
import {
  DeleteStockJournalUseCase,
  UpdateStockJournalUseCase,
} from '../application/update-stock-journal.usecase';
import { ApproveStockJournalUseCase } from '../application/approve-stock-journal.usecase';
import { PostStockJournalUseCase } from '../application/post-stock-journal.usecase';
import { ReverseStockJournalUseCase } from '../application/reverse-stock-journal.usecase';
import { StockJournalDto, StockJournalQueryService } from '../application/stock-journal-query.service';

class CreateStockJournalDto {
  @IsDateString() voucherDate!: string;
  @IsIn(STOCK_JOURNAL_MODES as unknown as string[]) mode!: string;
  @IsOptional() @IsUUID() fromGodownId?: string | null;
  @IsOptional() @IsUUID() toGodownId?: string | null;
  @IsUUID() itemId!: string;
  @IsNumberString() quantity!: string;
  @IsUUID() projectId!: string;
  @IsUUID() costCentreId!: string;
  @IsUUID() purposeId!: string;
  @IsOptional() @IsUUID() issuedById?: string | null;
  @IsOptional() @IsUUID() receivedById?: string | null;
  @IsOptional() @IsString() narration?: string | null;
}

class UpdateStockJournalDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsDateString() voucherDate?: string;
  @IsOptional() @IsIn(STOCK_JOURNAL_MODES as unknown as string[]) mode?: string;
  @IsOptional() @IsUUID() fromGodownId?: string | null;
  @IsOptional() @IsUUID() toGodownId?: string | null;
  @IsOptional() @IsUUID() itemId?: string;
  @IsOptional() @IsNumberString() quantity?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @IsUUID() purposeId?: string;
  @IsOptional() @IsUUID() issuedById?: string | null;
  @IsOptional() @IsUUID() receivedById?: string | null;
  @IsOptional() @IsString() narration?: string | null;
}

class VersionDto {
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class PostStockJournalDto extends VersionDto {
  @IsOptional() @IsBoolean() allowNegativeStock?: boolean;
  @IsOptional() @IsString() negativeStockReason?: string;
}

class ReasonDto extends VersionDto {
  @IsString() reason!: string;
}

class StockJournalQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() mode?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() godownId?: string;
  @IsOptional() @IsUUID() itemId?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
}

@ApiTags('Stock Journal')
@Controller('api/stock-journal')
export class StockJournalController {
  constructor(
    private readonly create: CreateStockJournalUseCase,
    private readonly update: UpdateStockJournalUseCase,
    private readonly del: DeleteStockJournalUseCase,
    private readonly approveUc: ApproveStockJournalUseCase,
    private readonly postUc: PostStockJournalUseCase,
    private readonly reverseUc: ReverseStockJournalUseCase,
    private readonly query: StockJournalQueryService,
  ) {}

  @Get()
  list(
    @Query() q: StockJournalQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<StockJournalDto>> {
    return this.query.list(q as never, actor);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<StockJournalDto> {
    return this.require(id, actor);
  }

  @Post()
  @HttpCode(201)
  create_(@Body() body: CreateStockJournalDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body as never, actor);
  }

  @Patch(':id')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateStockJournalDto,
    @CurrentActor() actor: Actor,
  ): Promise<StockJournalDto> {
    await this.update.execute(id, body as never, actor);
    return this.require(id, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    return this.del.execute(id, actor);
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _body: VersionDto,
    @CurrentActor() actor: Actor,
  ): Promise<StockJournalDto> {
    void _body;
    await this.approveUc.execute(id, actor);
    return this.require(id, actor);
  }

  @Post(':id/post')
  @HttpCode(200)
  async post_(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PostStockJournalDto,
    @CurrentActor() actor: Actor,
  ): Promise<StockJournalDto> {
    await this.postUc.execute(
      id,
      { allowNegativeStock: body.allowNegativeStock, negativeStockReason: body.negativeStockReason },
      actor,
    );
    return this.require(id, actor);
  }

  @Post(':id/reverse')
  @HttpCode(200)
  async reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
    @CurrentActor() actor: Actor,
  ): Promise<StockJournalDto> {
    await this.reverseUc.execute(id, body.reason, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<StockJournalDto> {
    const dto = await this.query.get(id, actor);
    if (!dto) throw new NotFoundException(`Stock Journal ${id} not found`);
    return dto;
  }
}
