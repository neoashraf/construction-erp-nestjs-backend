/**
 * JournalController — `/api/journal` (FR-GEN-004..020) plus `POST /api/journal/opening` for the one-time
 * go-live opening journal (FR-GEN-009..013). Journal draft→post→reverse lifecycle; the opening journal
 * is assembled from MAS figures and posted in one action. camelCase JSON + `{data,meta}` envelope +
 * canonical error codes. Real `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route
 * `@Roles({module:'GEN', action})` (tier2-rbac-guard-wiring, FR-AUD-012/013/017) — GET list/:id -> READ,
 * POST /opening -> POST, POST -> CREATE, PATCH -> UPDATE, DELETE -> DELETE, POST :id/post -> POST,
 * POST :id/reverse -> CANCEL. Money as strings.
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
  UseGuards,
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
import { JwtAuthGuard } from '../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../core/auth/presentation/require-permission.decorator';
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
@UseGuards(JwtAuthGuard, RolesGuard)
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
  @RequirePermission('contra_journal.vouchers', 'READ')
  list(@Query() q: JournalQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<JournalVoucherDto>> {
    return this.query.listJournal(q, actor);
  }

  @Post('opening')
  @RequirePermission('contra_journal.opening', 'POST')
  async opening(@Body() body: OpeningDto, @CurrentActor() actor: Actor): Promise<JournalVoucherDto> {
    const { id } = await this.openingUc.execute(body, actor);
    return this.require(id, actor);
  }

  @Get(':id')
  @RequirePermission('contra_journal.vouchers', 'READ')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<JournalVoucherDto> {
    return this.require(id, actor);
  }

  @Post()
  @RequirePermission('contra_journal.vouchers', 'CREATE')
  create_(@Body() body: CreateJournalDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  @RequirePermission('contra_journal.vouchers', 'UPDATE')
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
  @RequirePermission('contra_journal.vouchers', 'DELETE')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    return this.del.execute(id, actor);
  }

  @Post(':id/post')
  @HttpCode(200)
  @RequirePermission('contra_journal.vouchers', 'POST')
  async post(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<JournalVoucherDto> {
    await this.postUc.execute(id, actor);
    return this.require(id, actor);
  }

  @Post(':id/reverse')
  @HttpCode(200)
  @RequirePermission('contra_journal.vouchers', 'CANCEL')
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
