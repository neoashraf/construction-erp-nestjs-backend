/**
 * AttendanceDeviceController — admin CRUD for the fingerprint-device registry.
 *
 * WHY THIS ENDPOINT EXISTS: push ingestion (`POST /iclock/cdata`) resolves the tenant from the
 * device's `?SN=` serial via `attendance_device`. Until this controller, that table could only be
 * populated by hand in SQL or by the `DEVICE_DEFAULT_COMPANY_ID` fallback — which is wrong for a
 * multi-company deployment, since it funnels EVERY unknown serial into one company. Registering
 * each device explicitly is what keeps punches attributed to the right tenant.
 *
 * ── On `defaultProjectId` ────────────────────────────────────────────────────────────────────
 * Optional, and left empty by design in most cases. Reconciliation prefers the EMPLOYEE's own
 * project and only falls back to the device's, so one device already serves every project — an
 * employee's punches follow that employee. The device default exists solely so an employee with
 * NO project of their own is not skipped as `NO_PROJECT` and silently missing from reports.
 *
 * Mounted under `/api/attendance/devices`, alongside the sibling `/api/attendance/users` registry,
 * and gated on `hr.attendance` like every other attendance write.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../../core/auth/presentation/require-permission.decorator';
import { NoEnvelope } from '../../../../infrastructure/http/no-envelope.decorator';
import { AttendanceDeviceService } from '../application/attendance-device.service';
import { AttendanceDeviceDto } from '../domain/ports/attendance-device.repository';
import { AttendanceReportExceptionFilter } from './attendance-report-exception.filter';
import { NoStoreInterceptor } from './no-store.interceptor';

/**
 * Fields are `unknown` on purpose: the SERVICE owns the messages ("deviceSn is required",
 * "defaultProjectId does not belong to this company") because they are part of the contract and
 * some are cross-entity checks. Declaring the keys is what satisfies `forbidNonWhitelisted`.
 */
class CreateDeviceDto {
  @IsOptional() deviceSn?: unknown;
  @IsOptional() label?: unknown;
  @IsOptional() defaultProjectId?: unknown;
}

class UpdateDeviceDto {
  @IsOptional() label?: unknown;
  @IsOptional() defaultProjectId?: unknown;
  @IsOptional() isActive?: unknown;
}

@ApiTags('HR / Attendance Devices')
@Controller('api/attendance/devices')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(AttendanceReportExceptionFilter)
@UseInterceptors(NoStoreInterceptor)
@NoEnvelope()
export class AttendanceDeviceController {
  constructor(private readonly devices: AttendanceDeviceService) {}

  /** `lastSeenAt` is stamped by every device handshake/poll, so it doubles as a liveness column. */
  @Get()
  @RequirePermission('hr.attendance', 'READ')
  async list(@CurrentActor() actor: Actor): Promise<{ data: AttendanceDeviceDto[] }> {
    return { data: await this.devices.list(actor) };
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('hr.attendance', 'CREATE')
  async create(
    @Body() body: CreateDeviceDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ data: AttendanceDeviceDto }> {
    return { data: await this.devices.create(body, actor) };
  }

  /** PATCH, not PUT: `deviceSn` is immutable once punches reference it (see the service). */
  @Patch(':id')
  @RequirePermission('hr.attendance', 'UPDATE')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateDeviceDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ data: AttendanceDeviceDto }> {
    return { data: await this.devices.update(id, body, actor) };
  }

  /**
   * Refused once punches exist — deactivate instead, so recorded history keeps its device row.
   *
   * Gated on UPDATE rather than DELETE deliberately: no role in `seed-roles-permissions` grants
   * `hr.attendance:DELETE` (not even HR_MANAGER), so requiring it would make this route
   * permanently un-callable. The destructive case is already fenced by the punch-count guard.
   */
  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('hr.attendance', 'UPDATE')
  async remove(@Param('id') id: string, @CurrentActor() actor: Actor): Promise<void> {
    await this.devices.remove(id, actor);
  }
}
