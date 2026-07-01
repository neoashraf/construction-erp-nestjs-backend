/**
 * EmployeeController — `/api/hr/employees` (FR-HR-001/-002/-003). The office-staff master: CRUD + reassign
 * (append-only history) + deactivate/reactivate. camelCase JSON + `{data,meta}` envelope (interceptor) +
 * canonical/module error codes (filter). The actor (company implicit) is resolved via @CurrentActor. Money
 * is sent/returned as numeric(18,4) strings; dates 'YYYY-MM-DD'. Bank account no/name + TIN are write-only
 * (masked on read — NFR-002). Deactivate, not delete (no hard DELETE). Real
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route `@Roles({module:'HR', action})`
 * (tier2-rbac-guard-wiring, FR-AUD-012/013/017) — GET list/:id/:id/assignments -> READ, POST -> CREATE,
 * PATCH :id -> UPDATE, POST :id/reassign|:id/deactivate|:id/reactivate -> UPDATE.
 */
import {
  Body,
  Controller,
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
  IsBoolean,
  IsDateString,
  IsIn,
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
import { EmployeeService } from '../application/employee.service';
import { AssignmentDto, EmployeeDto, HrQueryService } from '../application/hr-query.service';
import { EditEmployee, NewEmployee } from '../domain/employee';

class CreateEmployeeDto {
  @IsString() employeeCode!: string;
  @IsString() name!: string;
  @IsString() designation!: string;
  @IsOptional() @IsUUID() defaultProjectId?: string;
  @IsOptional() @IsString() department?: string;
  @IsIn(['HEAD_OFFICE', 'SITE']) workBase!: 'HEAD_OFFICE' | 'SITE';
  @IsIn(['MONTHLY', 'DAILY']) wageType!: 'MONTHLY' | 'DAILY';
  @IsNumberString() wageAmount!: string;
  @IsOptional() @IsString() bankAccountName?: string;
  @IsOptional() @IsString() bankAccountNo?: string;
  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @IsBoolean() pfApplicable?: boolean;
  @IsOptional() @IsBoolean() gratuityApplicable?: boolean;
  @IsOptional() @IsBoolean() wppfApplicable?: boolean;
  @IsOptional() @IsString() tin?: string;
  @IsDateString() joiningDate!: string;
}

class UpdateEmployeeDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() designation?: string;
  @IsOptional() @IsUUID() defaultProjectId?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsIn(['HEAD_OFFICE', 'SITE']) workBase?: 'HEAD_OFFICE' | 'SITE';
  @IsOptional() @IsIn(['MONTHLY', 'DAILY']) wageType?: 'MONTHLY' | 'DAILY';
  @IsOptional() @IsNumberString() wageAmount?: string;
  @IsOptional() @IsString() bankAccountName?: string;
  @IsOptional() @IsString() bankAccountNo?: string;
  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @IsBoolean() pfApplicable?: boolean;
  @IsOptional() @IsBoolean() gratuityApplicable?: boolean;
  @IsOptional() @IsBoolean() wppfApplicable?: boolean;
  @IsOptional() @IsString() tin?: string;
}

class ReassignDto {
  @IsInt() @Min(1) version!: number;
  @IsUUID() projectId!: string;
  @IsDateString() effectiveDate!: string;
  @IsOptional() @IsString() note?: string;
}

class VersionDto {
  @IsInt() @Min(1) version!: number;
}

class EmployeeQueryDto {
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: string;
  @IsOptional() @IsUUID() defaultProjectId?: string;
  @IsOptional() @IsIn(['MONTHLY', 'DAILY']) wageType?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

@ApiTags('HR / Employees')
@Controller('api/hr/employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeeController {
  constructor(
    private readonly service: EmployeeService,
    private readonly query: HrQueryService,
  ) {}

  @Get()
  @Roles({ module: 'HR', action: 'READ' })
  list(@Query() q: EmployeeQueryDto, @CurrentActor() actor: Actor): Promise<Paginated<EmployeeDto>> {
    return this.query.listEmployees(q, actor);
  }

  @Get(':id')
  @Roles({ module: 'HR', action: 'READ' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor): Promise<EmployeeDto> {
    return this.require(id, actor);
  }

  @Get(':id/assignments')
  @Roles({ module: 'HR', action: 'READ' })
  assignments(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<AssignmentDto[]> {
    return this.query.listAssignments(id, actor);
  }

  @Post()
  @HttpCode(201)
  @Roles({ module: 'HR', action: 'CREATE' })
  create(@Body() body: CreateEmployeeDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.service.create(body as unknown as NewEmployee, actor);
  }

  @Patch(':id')
  @Roles({ module: 'HR', action: 'UPDATE' })
  async patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateEmployeeDto,
    @CurrentActor() actor: Actor,
  ): Promise<EmployeeDto> {
    const { version, ...patch } = body;
    await this.service.update(id, patch as EditEmployee, version, actor);
    return this.require(id, actor);
  }

  @Post(':id/reassign')
  @HttpCode(200)
  @Roles({ module: 'HR', action: 'UPDATE' })
  async reassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReassignDto,
    @CurrentActor() actor: Actor,
  ): Promise<EmployeeDto> {
    const { version, projectId, effectiveDate, note } = body;
    await this.service.reassign(id, { projectId, effectiveDate, note }, version, actor);
    return this.require(id, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @Roles({ module: 'HR', action: 'UPDATE' })
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VersionDto,
    @CurrentActor() actor: Actor,
  ): Promise<EmployeeDto> {
    await this.service.deactivate(id, body.version, actor);
    return this.require(id, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @Roles({ module: 'HR', action: 'UPDATE' })
  async reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VersionDto,
    @CurrentActor() actor: Actor,
  ): Promise<EmployeeDto> {
    await this.service.reactivate(id, body.version, actor);
    return this.require(id, actor);
  }

  private async require(id: string, actor: Actor): Promise<EmployeeDto> {
    const dto = await this.query.getEmployee(id, actor);
    if (!dto) throw new NotFoundException(`Employee ${id} not found`);
    return dto;
  }
}
