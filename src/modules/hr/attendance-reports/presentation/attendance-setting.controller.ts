/**
 * AttendanceSettingController — `/api/settings/attendance` (SUPPORTING_APIS_GUIDE §6). The late cut-off
 * `/api/reports/*` reports as `lateAfter` and uses to split Present from Late.
 *
 * Same two opt-outs as the report routes so the bodies match the source contract: `@NoEnvelope()` keeps
 * the `{ data, meta }` wrapper off, and `AttendanceReportExceptionFilter` renders the flat
 * `{ "error": "…" }` body (so an out-of-range hour reads exactly
 * `{"error":"lateAfterHour must be an integer between 0 and 23"}`).
 *
 * Body validation is deliberately NOT class-validator: the guide's messages are part of the contract, so
 * `normalizeTimeUnit` in the service produces them. The DTO only declares which fields are allowed, for
 * the global `forbidNonWhitelisted` pipe.
 */
import {
  Body,
  Controller,
  Get,
  Put,
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
import {
  AttendanceSettingDto,
  AttendanceSettingService,
} from '../application/attendance-setting.service';
import { AttendanceReportExceptionFilter } from './attendance-report-exception.filter';
import { NoStoreInterceptor } from './no-store.interceptor';

class UpdateAttendanceSettingDto {
  // `unknown` on purpose: the service owns the integer/range rules so the 400 message matches the
  // contract. Declaring the fields here is what lets them through `whitelist: true`.
  @IsOptional() lateAfterHour?: unknown;
  @IsOptional() lateAfterMinute?: unknown;
}

@ApiTags('HR / Attendance Settings')
@Controller('api/settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(AttendanceReportExceptionFilter)
@UseInterceptors(NoStoreInterceptor)
@NoEnvelope()
export class AttendanceSettingController {
  constructor(private readonly settings: AttendanceSettingService) {}

  @Get('attendance')
  @RequirePermission('hr.attendance', 'READ')
  get(@CurrentActor() actor: Actor): Promise<AttendanceSettingDto> {
    return this.settings.get(actor);
  }

  @Put('attendance')
  @RequirePermission('hr.attendance', 'UPDATE')
  update(
    @Body() body: UpdateAttendanceSettingDto,
    @CurrentActor() actor: Actor,
  ): Promise<AttendanceSettingDto> {
    return this.settings.set(body, actor);
  }
}
