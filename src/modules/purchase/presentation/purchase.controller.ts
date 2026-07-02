/**
 * PurchaseController — `/api/purchase/bills` (FR-PUR-004..014, -019..024). The Purchase Bill draft->post->
 * cancel->repost lifecycle. camelCase JSON + `{data,meta}` envelope (interceptor) + canonical/module error
 * codes (filter). The actor (company implicit) is resolved via @CurrentActor; PM project-scope is enforced
 * in the use cases + query service. Money/qty are numeric(18,4) strings; dates 'YYYY-MM-DD'.
 *
 * BRAND-NEW controller (no prior wiring) — real `@UseGuards(JwtAuthGuard, RolesGuard)` at the class level +
 * per-route `@Roles({module:'PUR', action})` mirroring sales.controller.ts/receipt.controller.ts EXACTLY:
 * GET -> READ, POST (create) -> CREATE, PATCH -> UPDATE, DELETE -> DELETE, POST .../post -> POST,
 * POST .../cancel|.../repost -> CANCEL, POST .../approve -> APPROVE.
 *
 * A second `PurchaseOrdersController` (in this same file/module) exposes `/api/purchase/orders` — a
 * separate class because the API contract's path prefix doesn't fit under `/api/purchase/bills`, mirroring
 * how SAL splits `SalesController`/`SalesProjectsController` — guarded identically.
 *
 * Brief 2 (purchase-grn-matching, FR-PUR-015..018/-020/-021) adds two more classes on the same split
 * rationale: `PurchaseGrnsController` (`/api/purchase/grns` — create/read/list/post; the GRN is an
 * INFORMATIONAL physical-receipt record under the §10 Q4 option-(a) resolution, see domain/grn.ts) and
 * `PurchaseSuppliersController` (`/api/purchase/suppliers/:supplierId/register`). The three-way match view
 * (`GET /api/purchase/orders/:id/match`) rides `PurchaseOrdersController`. All guarded identically.
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
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Actor } from '../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../core/auth/presentation/roles.guard';
import { Roles } from '../../../core/auth/presentation/roles.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { CreatePurchaseBillUseCase } from '../application/create-purchase-bill.usecase';
import {
  DeletePurchaseBillUseCase,
  UpdatePurchaseBillDraftUseCase,
} from '../application/update-purchase-bill-draft.usecase';
import { PostPurchaseBillUseCase } from '../application/post-purchase-bill.usecase';
import { CancelPurchaseBillUseCase } from '../application/cancel-purchase-bill.usecase';
import { RepostPurchaseBillUseCase } from '../application/repost-purchase-bill.usecase';
import { CreatePurchaseOrderUseCase } from '../application/create-purchase-order.usecase';
import { ApprovePurchaseOrderUseCase } from '../application/approve-purchase-order.usecase';
import {
  CancelPurchaseOrderUseCase,
  UpdatePurchaseOrderDraftUseCase,
} from '../application/update-purchase-order-draft.usecase';
import { CreateGrnUseCase } from '../application/create-grn.usecase';
import { PostGrnUseCase, PostGrnResult } from '../application/post-grn.usecase';
import { EditPurchaseBill, NewPurchaseBillLine } from '../domain/purchase-bill';
import { NewPurchaseOrderLine } from '../domain/purchase-order';
import { NewGrnLine } from '../domain/grn';
import {
  GrnDto,
  GrnSummaryDto,
  PoMatchDto,
  PurchaseBillDto,
  PurchaseBillSummaryDto,
  PurchaseOrderDto,
  PurchaseOrderSummaryDto,
  PurchaseRegisterDto,
  PurchaseQueryService,
} from '../application/purchase-query.service';

// ---- DTOs (Purchase Bill) --------------------------------------------------------------------------

class BillLineDto implements NewPurchaseBillLine {
  @IsOptional() @IsUUID() itemId?: string | null;
  @IsOptional() @IsUUID() expenseAccountId?: string | null;
  @IsBoolean() isStockLine!: boolean;
  @IsNumberString() billedQty!: string;
  @IsNumberString() rate!: string;
  @IsOptional() @IsUUID() godownId?: string | null;
  @IsUUID() projectId!: string;
  @IsUUID() costCentreId!: string;
  @IsUUID() purposeId!: string;
  @IsOptional() @IsNumberString() vatInputAmount?: string;
  @IsOptional() @IsNumberString() tdsAmount?: string;
  @IsOptional() @IsNumberString() aitAmount?: string;
}

class CreateBillDto {
  @IsUUID() projectId!: string;
  @IsUUID() supplierId!: string;
  @IsOptional() @IsUUID() purchaseOrderId?: string;
  @IsOptional() @IsString() supplierInvoiceRef?: string;
  @IsDateString() billDate!: string;
  @IsDateString() dueDate!: string;
  @IsOptional() @IsString() narration?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => BillLineDto) lines!: BillLineDto[];
}

class UpdateBillDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() purchaseOrderId?: string;
  @IsOptional() @IsString() supplierInvoiceRef?: string;
  @IsOptional() @IsDateString() billDate?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() narration?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BillLineDto) lines?: BillLineDto[];
}

class VersionDto {
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class CancelBillDto {
  @IsString() reason!: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class RepostBillDto extends UpdateBillDto {
  @IsString() reason!: string;
}

class BillQueryDto {
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() purchaseOrderId?: string;
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @IsString() entryNo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

// ---- DTOs (Purchase Order) -------------------------------------------------------------------------

class OrderLineDto implements NewPurchaseOrderLine {
  @IsUUID() itemId!: string;
  @IsNumberString() orderedQty!: string;
  @IsNumberString() rate!: string;
  @IsUUID() godownId!: string;
  @IsUUID() projectId!: string;
  @IsUUID() costCentreId!: string;
  @IsUUID() purposeId!: string;
}

class CreateOrderDto {
  @IsUUID() projectId!: string;
  @IsUUID() supplierId!: string;
  @IsOptional() @IsString() poRefNo?: string;
  @IsDateString() poDate!: string;
  @IsOptional() @IsDateString() expectedDeliveryDate?: string;
  @IsOptional() @IsString() narration?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OrderLineDto) lines!: OrderLineDto[];
}

class UpdateOrderDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsString() poRefNo?: string;
  @IsOptional() @IsDateString() poDate?: string;
  @IsOptional() @IsDateString() expectedDeliveryDate?: string;
  @IsOptional() @IsString() narration?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OrderLineDto) lines?: OrderLineDto[];
}

class CancelOrderDto {
  @IsString() reason!: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class OrderQueryDto {
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

// ---- DTOs (GRN) --------------------------------------------------------------------------------------

class GrnLineDto implements NewGrnLine {
  @IsOptional() @IsUUID() purchaseBillLineId?: string | null;
  @IsUUID() itemId!: string;
  @IsNumberString() receivedQty!: string;
  @IsNumberString() rate!: string;
  @IsUUID() godownId!: string;
  @IsOptional() @IsUUID() projectId?: string | null;
  @IsUUID() costCentreId!: string;
  @IsUUID() purposeId!: string;
}

class CreateGrnDto {
  @IsUUID() projectId!: string;
  @IsUUID() supplierId!: string;
  @IsOptional() @IsUUID() purchaseOrderId?: string;
  @IsOptional() @IsUUID() purchaseBillId?: string;
  @IsOptional() @IsString() grnRefNo?: string;
  @IsDateString() receiptDate!: string;
  @IsOptional() @IsString() narration?: string;
  /** Omit to default from the referenced bill/PO's open (unreceived) quantities (FR-PUR-018). */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => GrnLineDto) lines?: GrnLineDto[];
}

class GrnQueryDto {
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() purchaseBillId?: string;
  @IsOptional() @IsUUID() purchaseOrderId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

class RegisterQueryDto {
  @IsOptional() @IsUUID() financialYearId?: string;
}

// ---- Purchase Bill controller ------------------------------------------------------------------------

@ApiTags('Purchase / Bill')
@Controller('api/purchase/bills')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PurchaseController {
  constructor(
    private readonly create: CreatePurchaseBillUseCase,
    private readonly update: UpdatePurchaseBillDraftUseCase,
    private readonly del: DeletePurchaseBillUseCase,
    private readonly postUc: PostPurchaseBillUseCase,
    private readonly cancelUc: CancelPurchaseBillUseCase,
    private readonly repostUc: RepostPurchaseBillUseCase,
    private readonly query: PurchaseQueryService,
  ) {}

  @Get()
  @Roles({ module: 'PUR', action: 'READ' })
  list(@Query() q: BillQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<PurchaseBillSummaryDto>> {
    return this.query.listBills(q, actor);
  }

  @Get(':id')
  @Roles({ module: 'PUR', action: 'READ' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<PurchaseBillDto> {
    return this.require(id, actor);
  }

  @Post()
  @HttpCode(201)
  @Roles({ module: 'PUR', action: 'CREATE' })
  async create_(@Body() body: CreateBillDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    const res = await this.create.execute(body, actor);
    return { id: res.id };
  }

  @Patch(':id')
  @Roles({ module: 'PUR', action: 'UPDATE' })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBillDto,
    @CurrentActor() actor: Actor,
  ): Promise<PurchaseBillDto> {
    const { version, ...patch } = body;
    await this.update.execute(id, patch as EditPurchaseBill, version, actor);
    return this.require(id, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles({ module: 'PUR', action: 'DELETE' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    return this.del.execute(id, actor);
  }

  @Post(':id/post')
  @HttpCode(200)
  @Roles({ module: 'PUR', action: 'POST' })
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _body: VersionDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ id: string; entryNo: string; journalEntryId: string; status: 'POSTED'; netPayableAmount: string }> {
    void _body;
    const res = await this.postUc.execute(id, actor);
    return {
      id,
      entryNo: res.entryNo,
      journalEntryId: res.entryId,
      status: 'POSTED',
      netPayableAmount: res.netPayableAmount,
    };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles({ module: 'PUR', action: 'CANCEL' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelBillDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ id: string; status: 'CANCELLED'; reversalEntryId: string; reversalEntryNo: string }> {
    const res = await this.cancelUc.execute(id, body.reason, actor);
    return { id, status: 'CANCELLED', reversalEntryId: res.reversalEntryId, reversalEntryNo: res.reversalEntryNo };
  }

  @Post(':id/repost')
  @HttpCode(200)
  @Roles({ module: 'PUR', action: 'CANCEL' })
  async repost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RepostBillDto,
    @CurrentActor() actor: Actor,
  ): Promise<{
    id: string;
    status: 'POSTED';
    entryNo: string;
    reversalEntryNo: string;
    netPayableAmount: string;
  }> {
    const { version, reason, ...patch } = body;
    void version;
    const res = await this.repostUc.execute(id, patch as EditPurchaseBill, reason, actor);
    return {
      id,
      status: 'POSTED',
      entryNo: res.entryNo,
      reversalEntryNo: res.reversalEntryNo,
      netPayableAmount: res.netPayableAmount,
    };
  }

  private async require(id: string, actor: Actor): Promise<PurchaseBillDto> {
    const dto = await this.query.getBill(id, actor);
    if (!dto) throw new NotFoundException(`Purchase Bill ${id} not found`);
    return dto;
  }
}

// ---- Purchase Order controller -----------------------------------------------------------------------

@ApiTags('Purchase / Order')
@Controller('api/purchase/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PurchaseOrdersController {
  constructor(
    private readonly create: CreatePurchaseOrderUseCase,
    private readonly update: UpdatePurchaseOrderDraftUseCase,
    private readonly approveUc: ApprovePurchaseOrderUseCase,
    private readonly cancelUc: CancelPurchaseOrderUseCase,
    private readonly query: PurchaseQueryService,
  ) {}

  @Get()
  @Roles({ module: 'PUR', action: 'READ' })
  list(@Query() q: OrderQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<PurchaseOrderSummaryDto>> {
    return this.query.listOrders(q, actor);
  }

  @Get(':id')
  @Roles({ module: 'PUR', action: 'READ' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<PurchaseOrderDto> {
    return this.require(id, actor);
  }

  /** The PO→Bill→GRN three-way match — per line ordered/billed/received/open/matchStatus, all computed
   *  over the voucher records, never stored (FR-PUR-017, FR-PUR-018; AC8). */
  @Get(':id/match')
  @Roles({ module: 'PUR', action: 'READ' })
  match(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<PoMatchDto> {
    return this.query.poMatch(id, actor);
  }

  @Post()
  @HttpCode(201)
  @Roles({ module: 'PUR', action: 'CREATE' })
  async create_(@Body() body: CreateOrderDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    const res = await this.create.execute(
      { ...body, poRefNo: body.poRefNo ?? null, expectedDeliveryDate: body.expectedDeliveryDate ?? null },
      actor,
    );
    return { id: res.id };
  }

  @Patch(':id')
  @Roles({ module: 'PUR', action: 'UPDATE' })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateOrderDto,
    @CurrentActor() actor: Actor,
  ): Promise<PurchaseOrderDto> {
    const { version, ...patch } = body;
    await this.update.execute(id, patch, version, actor);
    return this.require(id, actor);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles({ module: 'PUR', action: 'APPROVE' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _body: VersionDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ id: string; status: string; approvedBy: string; approvedAt: string }> {
    void _body;
    const res = await this.approveUc.execute(id, actor);
    return { id, status: res.status, approvedBy: res.approvedBy, approvedAt: res.approvedAt.toISOString() };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles({ module: 'PUR', action: 'CANCEL' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelOrderDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ id: string; status: 'CANCELLED' }> {
    await this.cancelUc.execute(id, body.reason, body.version ?? 1, actor);
    return { id, status: 'CANCELLED' };
  }

  private async require(id: string, actor: Actor): Promise<PurchaseOrderDto> {
    const dto = await this.query.getOrder(id, actor);
    if (!dto) throw new NotFoundException(`Purchase Order ${id} not found`);
    return dto;
  }
}

// ---- GRN controller ------------------------------------------------------------------------------------

/**
 * `/api/purchase/grns` (FR-PUR-015..018). Routes per the API contract: create (PUR:CREATE — the Store
 * Keeper's action, SRS §3), list/read (PUR:READ), post (PUR:POST). The contract exposes NO PATCH/DELETE
 * and NO cancel route for a GRN, so none are shipped (DRAFT-only edit is a domain guard; `CancelGrnUseCase`
 * exists for permissioned internal use). Under the §10 Q4 option-(a) resolution a GRN post records the
 * match status ONLY — no inventory movement, no ledger entry, no number (see domain/grn.ts).
 */
@ApiTags('Purchase / GRN')
@Controller('api/purchase/grns')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PurchaseGrnsController {
  constructor(
    private readonly create: CreateGrnUseCase,
    private readonly postUc: PostGrnUseCase,
    private readonly query: PurchaseQueryService,
  ) {}

  @Get()
  @Roles({ module: 'PUR', action: 'READ' })
  list(@Query() q: GrnQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<GrnSummaryDto>> {
    return this.query.listGrns(q, actor);
  }

  @Get(':id')
  @Roles({ module: 'PUR', action: 'READ' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<GrnDto> {
    const dto = await this.query.getGrn(id, actor);
    if (!dto) throw new NotFoundException(`GRN ${id} not found`);
    return dto;
  }

  @Post()
  @HttpCode(201)
  @Roles({ module: 'PUR', action: 'CREATE' })
  async create_(@Body() body: CreateGrnDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    const res = await this.create.execute(body, actor);
    return { id: res.id };
  }

  @Post(':id/post')
  @HttpCode(200)
  @Roles({ module: 'PUR', action: 'POST' })
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _body: VersionDto,
    @CurrentActor() actor: Actor,
  ): Promise<PostGrnResult> {
    void _body;
    return this.postUc.execute(id, actor);
  }
}

// ---- Supplier register controller -------------------------------------------------------------------------

/** `/api/purchase/suppliers/:supplierId/register` — the per-supplier purchase register (FR-PUR-020/-021). */
@ApiTags('Purchase / Supplier register')
@Controller('api/purchase/suppliers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PurchaseSuppliersController {
  constructor(private readonly query: PurchaseQueryService) {}

  @Get(':supplierId/register')
  @Roles({ module: 'PUR', action: 'READ' })
  register(
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @Query() q: RegisterQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<PurchaseRegisterDto> {
    return this.query.supplierRegister(supplierId, actor, q.financialYearId);
  }
}
