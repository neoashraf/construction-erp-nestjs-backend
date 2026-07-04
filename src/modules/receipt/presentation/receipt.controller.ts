/**
 * ReceiptController — `/api/receipt` (FR-REC-001..025). The receipt voucher draft->post->cancel->repost
 * lifecycle, for both IPC-linked and general/non-project receipts, plus `GET /api/receipt/ipc/{ipcId}`.
 * camelCase JSON + `{data,meta}` envelope (interceptor) + canonical/module error codes (filter). The
 * actor (company implicit) is resolved via @CurrentActor; PM project-scope is enforced in the query
 * service. Money is sent/returned as numeric(18,4) strings; dates 'YYYY-MM-DD'. For IPC_LINKED,
 * partyId/projectId/costCentreId/purposeId are resolved server-side from the referenced posted IPC, never
 * client-supplied. Real `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route
 * `@Roles({module:'REC', action})` (receipts-voucher-core #24, mirrors sales.controller.ts exactly) —
 * GET routes -> READ, POST /api/receipt -> CREATE, PATCH/DELETE -> UPDATE/DELETE, POST .../post -> POST,
 * POST .../cancel|.../repost -> CANCEL.
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
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Actor } from '../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../core/auth/presentation/require-permission.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { CreateReceiptUseCase } from '../application/create-receipt.usecase';
import { DeleteReceiptUseCase, UpdateReceiptDraftUseCase } from '../application/update-receipt-draft.usecase';
import { PostReceiptUseCase } from '../application/post-receipt.usecase';
import { CancelReceiptUseCase } from '../application/cancel-receipt.usecase';
import { RepostReceiptUseCase } from '../application/repost-receipt.usecase';
import { EditReceipt } from '../domain/receipt';
import {
  ReceiptDto,
  ReceiptQueryService,
  ReceiptSummaryDto,
  ReceiptsAppliedToIpc,
} from '../application/receipt-query.service';

const PAYMENT_MODES = ['CASH', 'MFS', 'BANK_TRANSFER', 'CHEQUE'] as const;
const RECEIPT_TYPES = ['IPC_LINKED', 'GENERAL'] as const;

class CreateReceiptDto {
  @IsIn(RECEIPT_TYPES) receiptType!: 'IPC_LINKED' | 'GENERAL';
  @IsDateString() receiptDate!: string;
  @IsIn(PAYMENT_MODES) paymentMode!: 'CASH' | 'MFS' | 'BANK_TRANSFER' | 'CHEQUE';
  @IsUUID() depositAccountId!: string;
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @IsUUID() ipcId?: string;
  @IsOptional() @IsUUID() generalTargetAccountId?: string;
  @IsOptional() projectId?: string | null;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() purposeId?: string | null;
  @IsNumberString() amountSettled!: string;
  @IsOptional() @IsNumberString() taxDeductedAtSource?: string;
  @IsOptional() @IsString() chequeTxnRef?: string;
  @IsOptional() @IsString() narration?: string;
}

class UpdateReceiptDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsIn(RECEIPT_TYPES) receiptType?: 'IPC_LINKED' | 'GENERAL';
  @IsOptional() @IsDateString() receiptDate?: string;
  @IsOptional() @IsIn(PAYMENT_MODES) paymentMode?: 'CASH' | 'MFS' | 'BANK_TRANSFER' | 'CHEQUE';
  @IsOptional() @IsUUID() depositAccountId?: string;
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @IsUUID() ipcId?: string;
  @IsOptional() @IsUUID() generalTargetAccountId?: string;
  @IsOptional() projectId?: string | null;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() purposeId?: string | null;
  @IsOptional() @IsNumberString() amountSettled?: string;
  @IsOptional() @IsNumberString() taxDeductedAtSource?: string;
  @IsOptional() @IsString() chequeTxnRef?: string;
  @IsOptional() @IsString() narration?: string;
}

class PostReceiptDto {
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class CancelReceiptDto {
  @IsString() reason!: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class RepostReceiptDto extends UpdateReceiptDto {
  @IsString() reason!: string;
}

class ReceiptQueryDto {
  @IsOptional() @IsIn(RECEIPT_TYPES) receiptType?: 'IPC_LINKED' | 'GENERAL';
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsUUID() ipcId?: string;
  @IsOptional() @IsString() paymentMode?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @IsString() entryNo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

@ApiTags('Receipts')
@Controller('api/receipt')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReceiptController {
  constructor(
    private readonly create: CreateReceiptUseCase,
    private readonly update: UpdateReceiptDraftUseCase,
    private readonly del: DeleteReceiptUseCase,
    private readonly postUc: PostReceiptUseCase,
    private readonly cancelUc: CancelReceiptUseCase,
    private readonly repostUc: RepostReceiptUseCase,
    private readonly query: ReceiptQueryService,
  ) {}

  @Get()
  @RequirePermission('receipts', 'READ')
  list(@Query() q: ReceiptQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<ReceiptSummaryDto>> {
    return this.query.list(q, actor);
  }

  @Get('ipc/:ipcId')
  @RequirePermission('receipts', 'READ')
  receiptsAppliedToIpc(
    @Param('ipcId', ParseUUIDPipe) ipcId: string,
    @CurrentActor() actor: Actor,
  ): Promise<ReceiptsAppliedToIpc> {
    return this.query.receiptsAppliedToIpc(ipcId, actor);
  }

  @Get(':id')
  @RequirePermission('receipts', 'READ')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<ReceiptDto> {
    return this.require(id, actor);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('receipts', 'CREATE')
  create_(@Body() body: CreateReceiptDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  @RequirePermission('receipts', 'UPDATE')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReceiptDto,
    @CurrentActor() actor: Actor,
  ): Promise<ReceiptDto> {
    const { version, ...patch } = body;
    await this.update.execute(id, patch as EditReceipt, version, actor);
    return this.require(id, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('receipts', 'DELETE')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    return this.del.execute(id, actor);
  }

  @Post(':id/post')
  @HttpCode(200)
  @RequirePermission('receipts', 'POST')
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _body: PostReceiptDto,
    @CurrentActor() actor: Actor,
  ): Promise<ReceiptDto> {
    void _body;
    await this.postUc.execute(id, actor);
    return this.require(id, actor);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('receipts', 'CANCEL')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelReceiptDto,
    @CurrentActor() actor: Actor,
  ): Promise<ReceiptDto> {
    await this.cancelUc.execute(id, body.reason, actor);
    return this.require(id, actor);
  }

  @Post(':id/repost')
  @HttpCode(200)
  @RequirePermission('receipts', 'CANCEL')
  async repost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RepostReceiptDto,
    @CurrentActor() actor: Actor,
  ): Promise<ReceiptDto> {
    const { version, reason, ...patch } = body;
    void version;
    await this.repostUc.execute(id, patch as EditReceipt, reason, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<ReceiptDto> {
    const dto = await this.query.get(id, actor);
    if (!dto) throw new NotFoundException(`Receipt ${id} not found`);
    return dto;
  }
}
