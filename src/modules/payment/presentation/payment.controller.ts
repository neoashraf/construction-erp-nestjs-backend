/**
 * PaymentController — `/api/payment`. The payment voucher draft->post->cancel->repost lifecycle for
 * supplier-bill / daily-labour / salary settlements. camelCase JSON + `{data,meta}` envelope (interceptor)
 * + canonical/module error codes (filter). The actor (company implicit) is resolved via @CurrentActor; PM
 * project-scope is enforced in the query service. Money is sent/returned as numeric(18,4) strings; dates
 * 'YYYY-MM-DD'. Real `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route `@Roles({module:'PAY', action})` —
 * GET routes -> READ, POST /api/payment -> CREATE, PATCH/DELETE -> UPDATE/DELETE, POST .../post -> POST,
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
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
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
import { Roles } from '../../../core/auth/presentation/roles.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { CreatePaymentUseCase, CreatePaymentResult } from '../application/create-payment.usecase';
import { DeletePaymentUseCase, UpdatePaymentDraftUseCase } from '../application/update-payment-draft.usecase';
import { PostPaymentUseCase } from '../application/post-payment.usecase';
import { CancelPaymentUseCase } from '../application/cancel-payment.usecase';
import { RepostPaymentUseCase } from '../application/repost-payment.usecase';
import { EditPayment, NewPayment } from '../domain/payment-voucher';
import {
  AppliedToPayableDto,
  OpenPayableRow,
  PaymentDto,
  PaymentQueryService,
  PaymentSummaryDto,
} from '../application/payment-query.service';
import { PayableType } from '../domain/allocation';

const PAYMENT_MODES = ['CASH', 'MFS', 'BANK_TRANSFER', 'CHEQUE', 'RTGS'] as const;
const PAYABLE_TYPES = ['PURCHASE_BILL', 'LABOUR_PAYABLE', 'SALARY'] as const;

class AllocationDto {
  @IsIn(PAYABLE_TYPES) payableType!: 'PURCHASE_BILL' | 'LABOUR_PAYABLE' | 'SALARY';
  @IsUUID() payableId!: string;
  @IsNumberString() amountAllocated!: string;
}

class CreatePaymentDto {
  @IsDateString() paymentDate!: string;
  @IsIn(PAYMENT_MODES) paymentMode!: 'CASH' | 'MFS' | 'BANK_TRANSFER' | 'CHEQUE' | 'RTGS';
  @IsUUID() paymentAccountId!: string;
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @IsString() chequeTxnRef?: string;
  @IsOptional() @IsNumberString() bankChargesAmount?: string;
  @IsOptional() @IsUUID() bankChargesProjectId?: string;
  @IsOptional() @IsUUID() bankChargesCostCentreId?: string;
  @IsOptional() @IsUUID() bankChargesPurposeId?: string;
  @IsNumberString() paymentAmount!: string;
  @IsOptional() @IsString() narration?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => AllocationDto) allocations!: AllocationDto[];
}

class UpdatePaymentDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsDateString() paymentDate?: string;
  @IsOptional() @IsIn(PAYMENT_MODES) paymentMode?: 'CASH' | 'MFS' | 'BANK_TRANSFER' | 'CHEQUE' | 'RTGS';
  @IsOptional() @IsUUID() paymentAccountId?: string;
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @IsString() chequeTxnRef?: string;
  @IsOptional() @IsNumberString() bankChargesAmount?: string;
  @IsOptional() @IsUUID() bankChargesProjectId?: string;
  @IsOptional() @IsUUID() bankChargesCostCentreId?: string;
  @IsOptional() @IsUUID() bankChargesPurposeId?: string;
  @IsOptional() @IsNumberString() paymentAmount?: string;
  @IsOptional() @IsString() narration?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AllocationDto) allocations?: AllocationDto[];
}

class PostPaymentDto {
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class CancelPaymentDto {
  @IsString() reason!: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class RepostPaymentDto extends UpdatePaymentDto {
  @IsString() reason!: string;
}

class PaymentQueryDto {
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @IsUUID() paymentAccountId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsString() paymentMode?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @IsString() entryNo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

class OpenPayablesQueryDto {
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @IsIn(PAYABLE_TYPES) payableType?: 'PURCHASE_BILL' | 'LABOUR_PAYABLE' | 'SALARY';
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

@ApiTags('Payments')
@Controller('api/payment')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentController {
  constructor(
    private readonly create: CreatePaymentUseCase,
    private readonly update: UpdatePaymentDraftUseCase,
    private readonly del: DeletePaymentUseCase,
    private readonly postUc: PostPaymentUseCase,
    private readonly cancelUc: CancelPaymentUseCase,
    private readonly repostUc: RepostPaymentUseCase,
    private readonly query: PaymentQueryService,
  ) {}

  @Get()
  @Roles({ module: 'PAY', action: 'READ' })
  list(@Query() q: PaymentQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<PaymentSummaryDto>> {
    return this.query.list(q, actor);
  }

  // Declared BEFORE @Get(':id') so these static segments are not swallowed by the :id param route.
  @Get('open-payables')
  @Roles({ module: 'PAY', action: 'READ' })
  openPayables(@Query() q: OpenPayablesQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<OpenPayableRow>> {
    return this.query.openPayables(q, actor);
  }

  @Get('payables/:payableType/:payableId/applied')
  @Roles({ module: 'PAY', action: 'READ' })
  appliedToPayable(
    @Param('payableType', new ParseEnumPipe(PAYABLE_TYPES)) payableType: PayableType,
    @Param('payableId', ParseUUIDPipe) payableId: string,
    @CurrentActor() actor: Actor,
  ): Promise<AppliedToPayableDto> {
    return this.query.appliedToPayable(payableType, payableId, actor);
  }

  @Get(':id')
  @Roles({ module: 'PAY', action: 'READ' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<PaymentDto> {
    return this.require(id, actor);
  }

  @Post()
  @HttpCode(201)
  @Roles({ module: 'PAY', action: 'CREATE' })
  create_(@Body() body: CreatePaymentDto, @CurrentActor() actor: Actor): Promise<CreatePaymentResult> {
    return this.create.execute(body as NewPayment, actor);
  }

  @Patch(':id')
  @Roles({ module: 'PAY', action: 'UPDATE' })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePaymentDto,
    @CurrentActor() actor: Actor,
  ): Promise<PaymentDto> {
    const { version, ...patch } = body;
    await this.update.execute(id, patch as EditPayment, version, actor);
    return this.require(id, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles({ module: 'PAY', action: 'DELETE' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    return this.del.execute(id, actor);
  }

  @Post(':id/post')
  @HttpCode(200)
  @Roles({ module: 'PAY', action: 'POST' })
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _body: PostPaymentDto,
    @CurrentActor() actor: Actor,
  ): Promise<PaymentDto> {
    void _body;
    await this.postUc.execute(id, actor);
    return this.require(id, actor);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles({ module: 'PAY', action: 'CANCEL' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelPaymentDto,
    @CurrentActor() actor: Actor,
  ): Promise<PaymentDto> {
    await this.cancelUc.execute(id, body.reason, actor);
    return this.require(id, actor);
  }

  @Post(':id/repost')
  @HttpCode(200)
  @Roles({ module: 'PAY', action: 'CANCEL' })
  async repost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RepostPaymentDto,
    @CurrentActor() actor: Actor,
  ): Promise<PaymentDto> {
    const { version, reason, ...patch } = body;
    void version;
    await this.repostUc.execute(id, patch as EditPayment, reason, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<PaymentDto> {
    const dto = await this.query.get(id, actor);
    if (!dto) throw new NotFoundException(`Payment ${id} not found`);
    return dto;
  }
}
