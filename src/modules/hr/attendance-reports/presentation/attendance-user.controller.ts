/**
 * AttendanceUserController — the device→employee registry (SUPPORTING_APIS_GUIDE §7).
 *
 * Mounted at `/api/attendance/users`, NOT the guide's `/api/users`: that path is this system's auth user
 * management (login accounts, roles, project assignments) and taking it over would break sign-in. The
 * bodies are otherwise the guide's — `{ data: … }`, upsert-by-userId, `201` on POST.
 *
 * Backed by the existing `employee` table, so this and `/api/hr/employees` are two views of one registry,
 * not two registries. Use `/api/hr/employees` for full employee lifecycle; this one exists so a device
 * enrolment can create the name↔code mapping the reports need with a minimal payload.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { AttendanceUserService } from '../application/attendance-user.service';
import { AttendanceUserDto } from '../domain/ports/attendance-user.repository';
import { AttendanceReportExceptionFilter } from './attendance-report-exception.filter';
import { NoStoreInterceptor } from './no-store.interceptor';

class UpsertAttendanceUserDto {
  // Typed `unknown`: the service owns the messages ("userId is required", "designation must be a string
  // or null") because they are part of the contract. Declaring them satisfies `forbidNonWhitelisted`.
  @IsOptional() userId?: unknown;
  @IsOptional() name?: unknown;
  @IsOptional() designation?: unknown;
}

@ApiTags('HR / Attendance Users')
@Controller('api/attendance/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(AttendanceReportExceptionFilter)
@UseInterceptors(NoStoreInterceptor)
@NoEnvelope()
export class AttendanceUserController {
  constructor(private readonly users: AttendanceUserService) {}

  @Get()
  @RequirePermission('hr.employees', 'READ')
  async list(@CurrentActor() actor: Actor): Promise<{ data: AttendanceUserDto[] }> {
    return { data: await this.users.list(actor) };
  }

  /** Upsert by `userId` — a repeated enrolment updates and still answers 201, as the guide specifies. */
  @Post()
  @HttpCode(201)
  @RequirePermission('hr.employees', 'CREATE')
  async upsert(
    @Body() body: UpsertAttendanceUserDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ data: AttendanceUserDto }> {
    return { data: await this.users.upsert(body, actor) };
  }
}
