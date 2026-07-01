/**
 * SalesController — `/api/sales/ipc` (FR-SAL-001..014, -021..023). The IPC voucher draft→post→cancel→
 * repost lifecycle. camelCase JSON + `{data,meta}` envelope (interceptor) + canonical/module error codes
 * (filter). The actor (company implicit) is resolved via @CurrentActor; PM project-scope is enforced in
 * the query service. Money is sent/returned as numeric(18,4) strings; dates 'YYYY-MM-DD'. `customerId`
 * and `currentlyDueAmount` are resolved/derived server-side, never client-supplied. Real
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route `@Roles({module:'SAL', action})`
 * (tier2-rbac-guard-wiring, FR-AUD-012/013/017) — GET /ipc, /ipc/:id -> READ, POST /ipc -> CREATE,
 * PATCH /ipc/:id -> UPDATE, DELETE /ipc/:id -> DELETE, POST /ipc/:id/post|/ipc/:id/repost -> POST,
 * POST /ipc/:id/cancel -> CANCEL.
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
import { Roles } from '../../../core/auth/presentation/roles.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { CreateIpcUseCase } from '../application/create-ipc.usecase';
import { DeleteIpcUseCase, UpdateIpcDraftUseCase } from '../application/update-ipc-draft.usecase';
import { PostIpcUseCase } from '../application/post-ipc.usecase';
import { CancelIpcUseCase } from '../application/cancel-ipc.usecase';
import { RepostIpcUseCase } from '../application/repost-ipc.usecase';
import { EditIpc } from '../domain/ipc';
import { IpcDto, IpcQueryService, IpcSummaryDto } from '../application/ipc-query.service';

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
    private readonly query: IpcQueryService,
  ) {}

  @Get()
  @Roles({ module: 'SAL', action: 'READ' })
  list(@Query() q: IpcQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<IpcSummaryDto>> {
    return this.query.list(q, actor);
  }

  @Get(':id')
  @Roles({ module: 'SAL', action: 'READ' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<IpcDto> {
    return this.require(id, actor);
  }

  @Post()
  @HttpCode(201)
  @Roles({ module: 'SAL', action: 'CREATE' })
  create_(@Body() body: CreateIpcDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.create.execute(body, actor);
  }

  @Patch(':id')
  @Roles({ module: 'SAL', action: 'UPDATE' })
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
  @Roles({ module: 'SAL', action: 'DELETE' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<void> {
    return this.del.execute(id, actor);
  }

  @Post(':id/post')
  @HttpCode(200)
  @Roles({ module: 'SAL', action: 'POST' })
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
  @Roles({ module: 'SAL', action: 'CANCEL' })
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
  @Roles({ module: 'SAL', action: 'POST' })
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

  private async require(id: string, actor: Actor): Promise<IpcDto> {
    const dto = await this.query.get(id, actor);
    if (!dto) throw new NotFoundException(`IPC ${id} not found`);
    return dto;
  }
}
