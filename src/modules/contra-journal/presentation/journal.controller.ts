/**
 * JournalController — `/api/journal` (FR-GEN-004..020) plus `POST /api/journal/opening` for the one-time
 * go-live opening journal (FR-GEN-009..013). Journal draft→post→reverse lifecycle; the opening journal
 * is assembled from MAS figures and posted in one action. camelCase JSON + `{data,meta}` envelope +
 * canonical error codes. Money as strings; the actor is resolved via @CurrentActor.
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
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Actor } from '../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../core/auth/presentation/current-actor.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { CreateJournalUseCase } from '../application/create-journal.usecase';
import { DeleteJournalUseCase, UpdateJournalUseCase } from '../application/update-journal.usecase';
import { PostJournalUseCase } from '../application/post-journal.usecase';
import { PostOpeningJournalUseCase } from '../application/post-opening-journal.usecase';
import { ReverseJournalUseCase } from '../application/reverse-voucher.usecase';
import { JournalVoucherDto, ContraJournalQueryService } from './contra-journal.query-service';

class JournalLineDto {
  @IsUUID() accountId!: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @IsUUID() purposeId?: string;
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @IsNumberString() debit?: string;
  @IsOptional() @IsNumberString() credit?: string;
  @IsOptional() @IsString() narration?: string;
}
class CreateJournalDto {
  @IsOptional() @IsIn(['JOURNAL']) voucherType?: 'JOURNAL';
  @IsDateString() voucherDate!: string;
  @IsOptional() @IsString() narration?: string;
  @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}
class UpdateJournalDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsDateString() voucherDate?: string;
  @IsOptional() @IsString() narration?: string;
  @IsOptional() @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => JournalLineDto)
  lines?: JournalLineDto[];
}
class ReverseDto {
  @IsString() reason!: string;
}
class OpeningDto {
  @IsDateString() voucherDate!: string;
  @IsOptional() @IsString() narration?: string;
}
class JournalQueryDto {
  @IsOptional() @IsIn(['JOURNAL', 'OPENING']) voucherType?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @IsString() entryNo?: string;
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

@ApiTags('Journal Voucher')
@Controller('api/journal')
export class JournalController {
  constructor(
    private readonly create: CreateJournalUseCase,
    private readonly update: UpdateJournalUseCase,
    private readonly del: DeleteJournalUseCase,
    private readonly postUc: PostJournalUseCase,
    private readonly openingUc: PostOpeningJournalUseCase,
    private readonly reverseUc: ReverseJournalUseCase,
    private readonly query: ContraJournalQueryService,
  ) {}

  @Get()
  list(@Query() q: JournalQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<JournalVoucherDto>> {
    return this.query.listJournal(q, actor);
  }

  @Post('opening')
  async opening(@Body() body: OpeningDto, @CurrentActor() actor: Actor): Promise<JournalVoucherDto> {
    const { id } = await this.openingUc.execute(body, actor);
    return this.require(id, actor);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<JournalVoucherDto> {
    return this.require(id, actor);
  }

  @Post()
  create_(@Body() body: CreateJournalDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateJournalDto,
    @CurrentActor() actor: Actor,
  ): Promise<JournalVoucherDto> {
    await this.update.execute(
      id,
      { voucherDate: body.voucherDate, narration: body.narration, lines: body.lines },
      body.version,
      actor,
    );
    return this.require(id, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    return this.del.execute(id, actor);
  }

  @Post(':id/post')
  @HttpCode(200)
  async post(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<JournalVoucherDto> {
    await this.postUc.execute(id, actor);
    return this.require(id, actor);
  }

  @Post(':id/reverse')
  @HttpCode(200)
  async reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReverseDto,
    @CurrentActor() actor: Actor,
  ): Promise<JournalVoucherDto> {
    await this.reverseUc.execute(id, body.reason, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<JournalVoucherDto> {
    const dto = await this.query.getJournal(id, actor);
    if (!dto) throw new NotFoundException(`Journal voucher ${id} not found`);
    return dto;
  }
}
