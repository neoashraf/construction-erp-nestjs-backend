/**
 * HolidayController — `/api/holidays/*` (SUPPORTING_APIS_GUIDE §3). Weekly weekends and dated public
 * holidays; both feed `/api/reports/*`, where a government holiday overrides a weekly one on the same
 * date so the report can name the real holiday.
 *
 * ROUTE ORDER MATTERS: `government/import` and `government/import-excel` are declared BEFORE
 * `government`, and `government/:id` last. Nest matches in declaration order, so a later
 * `government/:something` route could otherwise swallow the import paths.
 *
 * `@NoEnvelope()` + `AttendanceReportExceptionFilter` keep the bodies and the flat `{ "error": "…" }`
 * shape identical to the source contract, as on the report routes. Validation messages come from the
 * pure normalisers in `holiday-rules`, not class-validator, for the same reason.
 *
 * RBAC note (aud-holidays-resource): gated on `hr.holidays`, NOT `hr.attendance` — the Holidays screen
 * is its own resource so a role holding `hr.attendance:CREATE` (e.g. Site Engineer) cannot also write
 * the HR Manager's holiday calendar. `hr.holidays` declares a full CRUD action set, so `deleteGovernment`
 * is gated on its own DELETE action (no UPDATE workaround needed, unlike the old hr.attendance gating).
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
  Post,
  Put,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../../core/auth/presentation/roles.guard';
import { RequirePermission } from '../../../../core/auth/presentation/require-permission.decorator';
import { NoEnvelope } from '../../../../infrastructure/http/no-envelope.decorator';
import { HolidayService } from '../application/holiday.service';
import { GovernmentHolidayDto } from '../domain/holiday-rules';
import { AttendanceReportExceptionFilter } from './attendance-report-exception.filter';
import { NoStoreInterceptor } from './no-store.interceptor';

class WeeklyHolidayDto {
  @IsOptional() weekdays?: unknown;
}

class GovernmentHolidayInputDto {
  @IsOptional() date?: unknown;
  @IsOptional() name?: unknown;
  @IsOptional() localName?: unknown;
}

class ImportYearDto {
  @IsOptional() year?: unknown;
}

class ImportRowsDto {
  @IsOptional() holidays?: unknown;
}

class HolidayYearQueryDto {
  @IsOptional() @IsString() year?: string;
}

@ApiTags('HR / Holidays')
@Controller('api/holidays')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(AttendanceReportExceptionFilter)
@UseInterceptors(NoStoreInterceptor)
@NoEnvelope()
export class HolidayController {
  constructor(private readonly holidays: HolidayService) {}

  // ── weekly ─────────────────────────────────────────────────────────────────────────────────────

  @Get('weekly')
  @RequirePermission('hr.holidays', 'READ')
  async getWeekly(@CurrentActor() actor: Actor): Promise<{ weekdays: number[] }> {
    return { weekdays: await this.holidays.getWeeklyHolidays(actor) };
  }

  /** FULL REPLACE — `{ "weekdays": [] }` clears every weekly holiday. Junk values are dropped. */
  @Put('weekly')
  @RequirePermission('hr.holidays', 'UPDATE')
  async setWeekly(
    @Body() body: WeeklyHolidayDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ weekdays: number[] }> {
    return { weekdays: await this.holidays.setWeeklyHolidays(body.weekdays, actor) };
  }

  // ── government (import routes BEFORE the bare/param routes) ─────────────────────────────────────

  @Get('government')
  @RequirePermission('hr.holidays', 'READ')
  async getGovernment(
    @Query() q: HolidayYearQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ holidays: GovernmentHolidayDto[] }> {
    return { holidays: await this.holidays.getGovernmentHolidays(q.year, actor) };
  }

  /** Year-end sync from the public-holiday feed. Manual rows are never overwritten. */
  @Post('government/import')
  @HttpCode(200)
  @RequirePermission('hr.holidays', 'CREATE')
  async importFromApi(
    @Body() body: ImportYearDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ holidays: GovernmentHolidayDto[] }> {
    return { holidays: await this.holidays.importFromApi(body.year, actor) };
  }

  /** Despite the name this takes NO file — the frontend parses the workbook and posts rows. */
  @Post('government/import-excel')
  @HttpCode(200)
  @RequirePermission('hr.holidays', 'CREATE')
  async importFromRows(
    @Body() body: ImportRowsDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ holidays: GovernmentHolidayDto[]; importedCount: number }> {
    const holidays = await this.holidays.importFromRows(body.holidays, actor);
    return { holidays, importedCount: holidays.length };
  }

  @Post('government')
  @HttpCode(200)
  @RequirePermission('hr.holidays', 'CREATE')
  async createGovernment(
    @Body() body: GovernmentHolidayInputDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ holiday: GovernmentHolidayDto }> {
    return { holiday: await this.holidays.createGovernmentHoliday(body, actor) };
  }

  @Delete('government/:id')
  @HttpCode(204)
  @RequirePermission('hr.holidays', 'DELETE')
  async deleteGovernment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    const deleted = await this.holidays.deleteGovernmentHoliday(id, actor);
    if (!deleted) throw new NotFoundException(`Holiday ${id} not found`);
  }
}
