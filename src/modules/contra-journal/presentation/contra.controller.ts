/**
 * ContraController — `/api/contra` (FR-GEN-001..003/-014..020). The contra voucher draft→post→reverse
 * lifecycle. camelCase JSON + `{data,meta}` envelope (interceptor) + canonical error codes (filter).
 * Guards land with auth-jwt; the actor is resolved via @CurrentActor. Money is sent/returned as strings.
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
import { CreateContraUseCase } from '../application/create-contra.usecase';
import { DeleteContraUseCase, UpdateContraUseCase } from '../application/update-contra.usecase';
import { PostContraUseCase } from '../application/post-contra.usecase';
import { ReverseContraUseCase } from '../application/reverse-voucher.usecase';
import { ContraVoucherDto, ContraJournalQueryService } from './contra-journal.query-service';

class ContraLineDto {
  @IsUUID() accountId!: string;
  @IsOptional() @IsNumberString() debit?: string;
  @IsOptional() @IsNumberString() credit?: string;
  @IsOptional() @IsString() narration?: string;
}
class CreateContraDto {
  @IsDateString() voucherDate!: string;
  @IsOptional() @IsString() narration?: string;
  @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => ContraLineDto)
  lines!: ContraLineDto[];
}
class UpdateContraDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsDateString() voucherDate?: string;
  @IsOptional() @IsString() narration?: string;
  @IsOptional() @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => ContraLineDto)
  lines?: ContraLineDto[];
}
class ReverseDto {
  @IsString() reason!: string;
}
class ContraQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @IsString() entryNo?: string;
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

@ApiTags('Contra Voucher')
@Controller('api/contra')
export class ContraController {
  constructor(
    private readonly create: CreateContraUseCase,
    private readonly update: UpdateContraUseCase,
    private readonly del: DeleteContraUseCase,
    private readonly postUc: PostContraUseCase,
    private readonly reverseUc: ReverseContraUseCase,
    private readonly query: ContraJournalQueryService,
  ) {}

  @Get()
  list(@Query() q: ContraQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<ContraVoucherDto>> {
    return this.query.listContra(q, actor);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<ContraVoucherDto> {
    return this.require(id, actor);
  }

  @Post()
  create_(@Body() body: CreateContraDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateContraDto,
    @CurrentActor() actor: Actor,
  ): Promise<ContraVoucherDto> {
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
  async post(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<ContraVoucherDto> {
    await this.postUc.execute(id, actor);
    return this.require(id, actor);
  }

  @Post(':id/reverse')
  @HttpCode(200)
  async reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReverseDto,
    @CurrentActor() actor: Actor,
  ): Promise<ContraVoucherDto> {
    await this.reverseUc.execute(id, body.reason, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<ContraVoucherDto> {
    const dto = await this.query.getContra(id, actor);
    if (!dto) throw new NotFoundException(`Contra voucher ${id} not found`);
    return dto;
  }
}
