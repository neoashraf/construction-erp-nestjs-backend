/**
 * SalesController — `/api/sales/ipc` (FR-SAL-001..014, -021..023, -018..020). The IPC voucher draft→post→
 * cancel→repost lifecycle PLUS (this brief, sales-ipc-retention-release) the controlled retention-release
 * action and its read surface. camelCase JSON + `{data,meta}` envelope (interceptor) + canonical/module
 * error codes (filter). The actor (company implicit) is resolved via @CurrentActor; PM project-scope is
 * enforced in the query service. Money is sent/returned as numeric(18,4) strings; dates 'YYYY-MM-DD'.
 * `customerId` and `currentlyDueAmount` are resolved/derived server-side, never client-supplied. Real
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route `@Roles({module:'SAL', action})`
 * (tier2-rbac-guard-wiring, FR-AUD-012/013/017) — GET /ipc, /ipc/:id -> READ, POST /ipc -> CREATE,
 * PATCH /ipc/:id -> UPDATE, DELETE /ipc/:id -> DELETE, POST /ipc/:id/post|/ipc/:id/repost -> POST,
 * POST /ipc/:id/cancel -> CANCEL. NEW: POST /ipc/:id/release-retention -> POST (it posts a ledger entry,
 * same convention as .../post and .../repost); GET /ipc/:id/retention-releases -> READ. The per-project
 * register lives on a second, sibling `SalesProjectsController` below (`/api/sales/projects` — the API
 * contract's path prefix doesn't fit under `/api/sales/ipc`), guarded identically in this same file/module.
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
import { CreateIpcUseCase } from '../application/create-ipc.usecase';
import { DeleteIpcUseCase, UpdateIpcDraftUseCase } from '../application/update-ipc-draft.usecase';
import { PostIpcUseCase } from '../application/post-ipc.usecase';
import { CancelIpcUseCase } from '../application/cancel-ipc.usecase';
import { RepostIpcUseCase } from '../application/repost-ipc.usecase';
import { ReleaseRetentionUseCase } from '../application/release-retention.usecase';
import { EditIpc } from '../domain/ipc';
import {
  IpcDto,
  IpcQueryService,
  IpcRegister,
  IpcSummaryDto,
  RetentionReleaseDto,
} from '../application/ipc-query.service';

class CreateIpcDto {
  @IsUUID() projectId!: string;
  @IsInt() @Min(1) ipcSeqNo!: number;
  @IsDateString() ipcDate!: string;
  @IsDateString() billDate!: string;
  @IsDateString() dueDate!: string;
  @IsNumberString() workCompletedPct!: string;
  @IsNumberString() certifiedAmount!: string;
  @IsUUID() costCentreId!: string;
  @IsUUID() purposeId!: string;
  @IsOptional() @IsNumberString() outputVatAmount?: string;
  @IsOptional() @IsNumberString() aitTdsAmount?: string;
  @IsOptional() @IsNumberString() retentionAmount?: string;
  @IsOptional() @IsNumberString() advanceRecoveredAmount?: string;
  @IsOptional() @IsString() narration?: string;
}

class UpdateIpcDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsInt() @Min(1) ipcSeqNo?: number;
  @IsOptional() @IsDateString() ipcDate?: string;
  @IsOptional() @IsDateString() billDate?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsNumberString() workCompletedPct?: string;
  @IsOptional() @IsNumberString() certifiedAmount?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @IsUUID() purposeId?: string;
  @IsOptional() @IsNumberString() outputVatAmount?: string;
  @IsOptional() @IsNumberString() aitTdsAmount?: string;
  @IsOptional() @IsNumberString() retentionAmount?: string;
  @IsOptional() @IsNumberString() advanceRecoveredAmount?: string;
  @IsOptional() @IsString() narration?: string;
}

class PostIpcDto {
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class CancelIpcDto {
  @IsString() reason!: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class RepostIpcDto extends UpdateIpcDto {
  @IsString() reason!: string;
}

class ReleaseRetentionDto {
  @IsDateString() releaseDate!: string;
  @IsOptional() @IsNumberString() releasedAmount?: string;
  @IsOptional() @IsString() narration?: string;
}

class IpcQueryDto {
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @IsString() entryNo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

@ApiTags('Sales / IPC')
@Controller('api/sales/ipc')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SalesController {
  constructor(
    private readonly create: CreateIpcUseCase,
    private readonly update: UpdateIpcDraftUseCase,
    private readonly del: DeleteIpcUseCase,
    private readonly postUc: PostIpcUseCase,
    private readonly cancelUc: CancelIpcUseCase,
    private readonly repostUc: RepostIpcUseCase,
    private readonly releaseUc: ReleaseRetentionUseCase,
    private readonly query: IpcQueryService,
  ) {}

  @Get()
  @RequirePermission('sales.ipcs', 'READ')
  list(@Query() q: IpcQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<IpcSummaryDto>> {
    return this.query.list(q, actor);
  }

  @Get(':id')
  @RequirePermission('sales.ipcs', 'READ')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<IpcDto> {
    return this.require(id, actor);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('sales.ipcs', 'CREATE')
  create_(@Body() body: CreateIpcDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  @RequirePermission('sales.ipcs', 'UPDATE')
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateIpcDto,
    @CurrentActor() actor: Actor,
  ): Promise<IpcDto> {
    const { version, ...patch } = body;
    await this.update.execute(id, patch as EditIpc, version, actor);
    return this.require(id, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('sales.ipcs', 'DELETE')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    return this.del.execute(id, actor);
  }

  @Post(':id/post')
  @HttpCode(200)
  @RequirePermission('sales.ipcs', 'POST')
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _body: PostIpcDto,
    @CurrentActor() actor: Actor,
  ): Promise<IpcDto> {
    void _body;
    await this.postUc.execute(id, actor);
    return this.require(id, actor);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('sales.ipcs', 'CANCEL')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelIpcDto,
    @CurrentActor() actor: Actor,
  ): Promise<IpcDto> {
    await this.cancelUc.execute(id, body.reason, actor);
    return this.require(id, actor);
  }

  @Post(':id/repost')
  @HttpCode(200)
  @RequirePermission('sales.ipcs', 'POST')
  async repost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RepostIpcDto,
    @CurrentActor() actor: Actor,
  ): Promise<IpcDto> {
    const { version, reason, ...patch } = body;
    void version;
    await this.repostUc.execute(id, patch as EditIpc, reason, actor);
    return this.require(id, actor);
  }

  @Post(':id/release-retention')
  @HttpCode(201)
  @RequirePermission('sales.ipcs', 'POST')
  async releaseRetention(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReleaseRetentionDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ id: string; ipcId: string; entryNo: string; releasedAmount: string; status: 'POSTED' }> {
    const res = await this.releaseUc.execute(id, body, actor);
    return { id: res.id, ipcId: res.ipcId, entryNo: res.entryNo, releasedAmount: res.releasedAmount, status: 'POSTED' };
  }

  @Get(':id/retention-releases')
  @RequirePermission('sales.ipcs', 'READ')
  retentionReleases(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<RetentionReleaseDto[]> {
    return this.query.retentionReleases(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<IpcDto> {
    const dto = await this.query.get(id, actor);
    if (!dto) throw new NotFoundException(`IPC ${id} not found`);
    return dto;
  }
}

/**
 * SalesProjectsController — `/api/sales/projects/{projectId}/register` (FR-SAL-015..017). The per-project
 * IPC register with running cumulative totals (design §5.4). A separate, sibling controller in the same
 * file/module because the API contract's path prefix (`/api/sales/projects`) doesn't fit under
 * `SalesController`'s `/api/sales/ipc` — guarded identically (`@UseGuards(JwtAuthGuard, RolesGuard)` +
 * `@RequirePermission('sales.ipcs', 'READ')`; PM project-scoping enforced in IpcQueryService.projectRegister).
 */
@ApiTags('Sales / IPC')
@Controller('api/sales/projects')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SalesProjectsController {
  constructor(private readonly query: IpcQueryService) {}

  @Get(':projectId/register')
  @RequirePermission('sales.ipc_register', 'READ')
  register(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('financialYearId') financialYearId: string | undefined,
    @CurrentActor() actor: Actor,
  ): Promise<IpcRegister> {
    return this.query.projectRegister(projectId, actor, financialYearId);
  }
}
