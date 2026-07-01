/**
 * RequisitionController — `/api/requisition` (FR-REQ-001..011, -020..023). The requisition workflow
 * lifecycle: create (DRAFT) · list/read · PATCH/DELETE (DRAFT only) · submit · approve · reject · close ·
 * approvals · outstanding. camelCase JSON + `{data,meta}` envelope (interceptor) + canonical/module error
 * codes (filter). The actor (company implicit) is resolved via @CurrentActor; PM project-scope is enforced
 * in the use cases + query service. Money/qty are numeric(18,4) strings; dates 'YYYY-MM-DD'. The ISSUE
 * endpoint (`…/issue`) is a SEPARATE downstream brief (#23 requisition-issue-posting) — this controller
 * exposes NO issue and writes NO ledger / moves NO stock.
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
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
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
import { Actor } from '../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../core/auth/presentation/current-actor.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { PRIORITIES } from '../domain/requisition-status';
import { CreateRequisitionUseCase } from '../application/create-requisition.usecase';
import { SubmitRequisitionUseCase } from '../application/submit-requisition.usecase';
import { ApproveRequisitionUseCase } from '../application/approve-requisition.usecase';
import { RejectRequisitionUseCase } from '../application/reject-requisition.usecase';
import { CloseRequisitionUseCase } from '../application/close-requisition.usecase';
import {
  DeleteRequisitionUseCase,
  UpdateRequisitionDraftUseCase,
} from '../application/update-requisition-draft.usecase';
import {
  OutstandingDto,
  RequisitionApprovalDto,
  RequisitionDto,
  RequisitionQueryService,
  RequisitionSummaryDto,
} from '../application/requisition-query.service';

class CreateLineDto {
  @IsUUID() itemId!: string;
  @IsNumberString() requestedQuantity!: string;
}

class CreateRequisitionDto {
  @IsUUID() projectId!: string;
  @IsUUID() costCentreId!: string;
  @IsUUID() purposeId!: string;
  @IsOptional() @IsUUID() fromGodownId?: string;
  @IsDateString() requiredDate!: string;
  @IsIn(PRIORITIES as unknown as string[]) priority!: string;
  @IsOptional() @IsString() narration?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => CreateLineDto) lines!: CreateLineDto[];
}

class UpdateRequisitionDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @IsUUID() purposeId?: string;
  @IsOptional() @IsUUID() fromGodownId?: string;
  @IsOptional() @IsDateString() requiredDate?: string;
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: string;
  @IsOptional() @IsString() narration?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CreateLineDto) lines?: CreateLineDto[];
}

class VersionDto {
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class ApproveDto extends VersionDto {
  @IsOptional() @IsString() note?: string;
}

class ReasonDto extends VersionDto {
  @IsString() reason!: string;
}

class RequisitionQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @IsUUID() submittedById?: string;
  @IsOptional() @IsDateString() requiredFrom?: string;
  @IsOptional() @IsDateString() requiredTo?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() hasOutstanding?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

@ApiTags('Requisition')
@Controller('api/requisition')
export class RequisitionController {
  constructor(
    private readonly create: CreateRequisitionUseCase,
    private readonly update: UpdateRequisitionDraftUseCase,
    private readonly del: DeleteRequisitionUseCase,
    private readonly submitUc: SubmitRequisitionUseCase,
    private readonly approveUc: ApproveRequisitionUseCase,
    private readonly rejectUc: RejectRequisitionUseCase,
    private readonly closeUc: CloseRequisitionUseCase,
    private readonly query: RequisitionQueryService,
  ) {}

  @Get()
  list(
    @Query() q: RequisitionQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<RequisitionSummaryDto>> {
    return this.query.list(q, actor);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<RequisitionDto> {
    return this.require(id, actor);
  }

  @Get(':id/approvals')
  async approvals(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<RequisitionApprovalDto[]> {
    const rows = await this.query.approvals(id, actor);
    if (rows === null) throw new NotFoundException(`Requisition ${id} not found`);
    return rows;
  }

  @Get(':id/outstanding')
  async outstanding(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<OutstandingDto> {
    const dto = await this.query.outstanding(id, actor);
    if (!dto) throw new NotFoundException(`Requisition ${id} not found`);
    return dto;
  }

  @Post()
  @HttpCode(201)
  create_(@Body() body: CreateRequisitionDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create
      .execute(body as never, actor)
      .then((r) => ({ id: r.id }));
  }

  @Patch(':id')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRequisitionDto,
    @CurrentActor() actor: Actor,
  ): Promise<RequisitionDto> {
    const { version, ...patch } = body;
    void version;
    await this.update.execute(id, patch as never, actor);
    return this.require(id, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    return this.del.execute(id, actor);
  }

  @Post(':id/submit')
  @HttpCode(200)
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _body: VersionDto,
    @CurrentActor() actor: Actor,
  ): Promise<RequisitionDto> {
    void _body;
    await this.submitUc.execute(id, actor);
    return this.require(id, actor);
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApproveDto,
    @CurrentActor() actor: Actor,
  ): Promise<RequisitionDto> {
    await this.approveUc.execute(id, body.note ?? null, actor);
    return this.require(id, actor);
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
    @CurrentActor() actor: Actor,
  ): Promise<RequisitionDto> {
    await this.rejectUc.execute(id, body.reason, actor);
    return this.require(id, actor);
  }

  @Post(':id/close')
  @HttpCode(200)
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
    @CurrentActor() actor: Actor,
  ): Promise<RequisitionDto> {
    await this.closeUc.execute(id, body.reason, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<RequisitionDto> {
    const dto = await this.query.get(id, actor);
    if (!dto) throw new NotFoundException(`Requisition ${id} not found`);
    return dto;
  }
}
