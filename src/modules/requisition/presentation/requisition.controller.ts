/**
 * RequisitionController — `/api/requisition` (FR-REQ-001..023). The requisition workflow lifecycle: create
 * (DRAFT) · list/read · PATCH/DELETE (DRAFT only) · submit · approve · reject · close · approvals ·
 * outstanding — PLUS the issue half (brief #23 — requisition-issue-posting): `…/issue`,
 * `…/issues/:issueId/reverse`, `GET /:id/issues`. camelCase JSON + `{data,meta}` envelope (interceptor) +
 * canonical/module error codes (filter). The actor (company implicit) is resolved via @CurrentActor; PM
 * project-scope is enforced in the use cases + query service. Money/qty are numeric(18,4) strings; dates
 * 'YYYY-MM-DD'. Real `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route `@Roles({module:'REQ', action})`
 * (tier2-rbac-guard-wiring, extended by brief #23, FR-AUD-012/013/017) — GET
 * list/:id/:id/approvals/:id/outstanding/:id/issues -> READ, POST -> CREATE, PATCH :id -> UPDATE, DELETE
 * :id -> DELETE, POST :id/submit|:id/close -> UPDATE, POST :id/approve -> APPROVE, POST :id/reject ->
 * REJECT, POST :id/issue -> POST, POST :id/issues/:issueId/reverse -> CANCEL.
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
import { JwtAuthGuard } from '../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../core/auth/presentation/require-permission.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { PRIORITIES } from '../domain/requisition-status';
import { CreateRequisitionUseCase } from '../application/create-requisition.usecase';
import { SubmitRequisitionUseCase } from '../application/submit-requisition.usecase';
import { ApproveRequisitionUseCase } from '../application/approve-requisition.usecase';
import { RejectRequisitionUseCase } from '../application/reject-requisition.usecase';
import { CloseRequisitionUseCase } from '../application/close-requisition.usecase';
import {
  IssueRequisitionUseCase,
  IssueRequisitionResult,
} from '../application/issue-requisition.usecase';
import { ReverseIssueUseCase } from '../application/reverse-issue.usecase';
import {
  DeleteRequisitionUseCase,
  UpdateRequisitionDraftUseCase,
} from '../application/update-requisition-draft.usecase';
import {
  OutstandingDto,
  RequisitionApprovalDto,
  RequisitionDto,
  RequisitionIssueDto,
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

class IssueLineDto {
  @IsUUID() requisitionLineId!: string;
  @IsNumberString() issueQuantity!: string;
  @IsOptional() @IsUUID() godownId?: string;
}

class IssueDto {
  @IsUUID() fromGodownId!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => IssueLineDto) lines!: IssueLineDto[];
  @IsOptional() @IsBoolean() allowNegativeStock?: boolean;
  @IsOptional() @IsString() negativeStockReason?: string | null;
  @IsOptional() @IsInt() @Min(1) version?: number;
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
@UseGuards(JwtAuthGuard, RolesGuard)
export class RequisitionController {
  constructor(
    private readonly create: CreateRequisitionUseCase,
    private readonly update: UpdateRequisitionDraftUseCase,
    private readonly del: DeleteRequisitionUseCase,
    private readonly submitUc: SubmitRequisitionUseCase,
    private readonly approveUc: ApproveRequisitionUseCase,
    private readonly rejectUc: RejectRequisitionUseCase,
    private readonly closeUc: CloseRequisitionUseCase,
    private readonly issueUc: IssueRequisitionUseCase,
    private readonly reverseIssueUc: ReverseIssueUseCase,
    private readonly query: RequisitionQueryService,
  ) {}

  @Get()
  @RequirePermission('requisitions.list', 'READ')
  list(
    @Query() q: RequisitionQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<RequisitionSummaryDto>> {
    return this.query.list(q, actor);
  }

  @Get(':id')
  @RequirePermission('requisitions.list', 'READ')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<RequisitionDto> {
    return this.require(id, actor);
  }

  @Get(':id/approvals')
  @RequirePermission('requisitions.approvals', 'READ')
  async approvals(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<RequisitionApprovalDto[]> {
    const rows = await this.query.approvals(id, actor);
    if (rows === null) throw new NotFoundException(`Requisition ${id} not found`);
    return rows;
  }

  @Get(':id/outstanding')
  @RequirePermission('requisitions.list', 'READ')
  async outstanding(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<OutstandingDto> {
    const dto = await this.query.outstanding(id, actor);
    if (!dto) throw new NotFoundException(`Requisition ${id} not found`);
    return dto;
  }

  @Get(':id/issues')
  @RequirePermission('requisitions.issues', 'READ')
  async issues(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<RequisitionIssueDto[]> {
    const rows = await this.query.issues(id, actor);
    if (rows === null) throw new NotFoundException(`Requisition ${id} not found`);
    return rows;
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('requisitions.list', 'CREATE')
  create_(@Body() body: CreateRequisitionDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create
      .execute(body as never, actor)
      .then((r) => ({ id: r.id }));
  }

  @Patch(':id')
  @RequirePermission('requisitions.list', 'UPDATE')
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
  @RequirePermission('requisitions.list', 'DELETE')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    return this.del.execute(id, actor);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('requisitions.list', 'UPDATE')
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
  @RequirePermission('requisitions.approvals', 'APPROVE')
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
  @RequirePermission('requisitions.approvals', 'REJECT')
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
  @RequirePermission('requisitions.list', 'UPDATE')
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
    @CurrentActor() actor: Actor,
  ): Promise<RequisitionDto> {
    await this.closeUc.execute(id, body.reason, actor);
    return this.require(id, actor);
  }

  @Post(':id/issue')
  @HttpCode(200)
  @RequirePermission('requisitions.issues', 'UPDATE')
  issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: IssueDto,
    @CurrentActor() actor: Actor,
  ): Promise<IssueRequisitionResult> {
    return this.issueUc.execute(
      id,
      {
        fromGodownId: body.fromGodownId,
        lines: body.lines,
        allowNegativeStock: body.allowNegativeStock,
        negativeStockReason: body.negativeStockReason,
      },
      actor,
    );
  }

  @Post(':id/issues/:issueId/reverse')
  @HttpCode(200)
  @RequirePermission('requisitions.issues', 'UPDATE')
  async reverseIssue(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() body: ReasonDto,
    @CurrentActor() actor: Actor,
  ): Promise<RequisitionDto> {
    await this.reverseIssueUc.execute(id, issueId, body.reason, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<RequisitionDto> {
    const dto = await this.query.get(id, actor);
    if (!dto) throw new NotFoundException(`Requisition ${id} not found`);
    return dto;
  }
}
