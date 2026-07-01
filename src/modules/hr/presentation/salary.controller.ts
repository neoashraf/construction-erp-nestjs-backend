/**
 * SalaryController — `/api/salary/sheets/*` (FR-HR-013..018). Generate → review/edit (per-line + bulk) →
 * post → payslips, plus reverse-and-repost correction. camelCase JSON + `{data,meta}` envelope
 * (interceptor) + canonical/module error codes (filter). Money as numeric(18,4) strings; dates
 * 'YYYY-MM-DD'. The SALARY posting is internal — there is no `POST /api/ledger`; the ledger impact is
 * triggered by `.../post` only (API contract). Real `@UseGuards(JwtAuthGuard, RolesGuard)` + per-route
 * `@Roles({module:'HR', action})` (identical treatment to AttendanceController, brief #36's retrofit
 * pattern) — GET (list/:id/payslips) -> READ, POST .../generate -> CREATE, PATCH (lines/components) ->
 * UPDATE, POST .../post -> POST, POST .../reverse -> CANCEL.
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
  IsArray,
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
import { Type } from 'class-transformer';
import { Actor } from '../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../core/auth/presentation/current-actor.decorator';
import { JwtAuthGuard } from '../../../core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../core/auth/presentation/roles.guard';
import { Roles } from '../../../core/auth/presentation/roles.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import { GenerateSalaryInput, PostSalaryResult, ReverseSalaryResult, SalaryService } from '../application/salary.service';
import { Payslip, PayslipService } from '../application/payslip.service';
import { HrQueryService, SalarySheetDto } from '../application/hr-query.service';
import { BulkApplyComponents, EditSalaryLineComponents } from '../domain/salary-sheet';

class GenerateSalaryDto {
  @IsUUID() financialYearId!: string;
  @IsString() periodLabel!: string;
  @IsDateString() periodStart!: string;
  @IsDateString() periodEnd!: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsUUID() purposeId!: string;
}

class SalarySheetQueryDto {
  @IsOptional() @IsUUID() financialYearId?: string;
  @IsOptional() @IsString() periodLabel?: string;
  @IsOptional() @IsIn(['DRAFT', 'POSTED', 'REVERSED']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

class EditLineDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsNumberString() allowances?: string;
  @IsOptional() @IsNumberString() tds?: string;
  @IsOptional() @IsNumberString() pf?: string;
  @IsOptional() @IsNumberString() advanceRecovery?: string;
  @IsOptional() @IsNumberString() otherDeductions?: string;
}

class ApplyRuleDto {
  @IsOptional() @IsNumberString() allowances?: string;
  @IsOptional() @IsNumberString() tdsRate?: string;
  @IsOptional() @IsNumberString() pf?: string;
  @IsOptional() @IsNumberString() advanceRecovery?: string;
}

class BulkComponentsDto {
  @ValidateNested() @Type(() => ApplyRuleDto) apply!: ApplyRuleDto;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) employeeIds?: string[];
  @IsInt() @Min(1) version!: number;
}

class PostSalaryDto {
  @IsInt() @Min(1) version!: number;
}

class ReverseSalaryDto {
  @IsString() reason!: string;
}

@ApiTags('HR / Salary')
@Controller('api/salary/sheets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SalaryController {
  constructor(
    private readonly service: SalaryService,
    private readonly payslips: PayslipService,
    private readonly query: HrQueryService,
  ) {}

  @Post('generate')
  @HttpCode(201)
  @Roles({ module: 'HR', action: 'CREATE' })
  generate(@Body() body: GenerateSalaryDto, @CurrentActor() actor: Actor): Promise<{ id: string }> {
    return this.service.generate(body as unknown as GenerateSalaryInput, actor);
  }

  @Get()
  @Roles({ module: 'HR', action: 'READ' })
  list(
    @Query() q: SalarySheetQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<SalarySheetDto>> {
    return this.query.listSalarySheets(q, actor);
  }

  @Get(':id')
  @Roles({ module: 'HR', action: 'READ' })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('includeLines') includeLines: string | undefined,
    @CurrentActor() actor: Actor,
  ): Promise<SalarySheetDto> {
    return this.require(id, includeLines === 'true', actor);
  }

  @Patch(':id/lines/:lineId')
  @Roles({ module: 'HR', action: 'UPDATE' })
  async editLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: EditLineDto,
    @CurrentActor() actor: Actor,
  ): Promise<SalarySheetDto> {
    const { version, ...patch } = body;
    await this.service.editLine(id, lineId, patch as EditSalaryLineComponents, version, actor);
    return this.require(id, true, actor);
  }

  @Patch(':id/components')
  @Roles({ module: 'HR', action: 'UPDATE' })
  async applyComponents(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BulkComponentsDto,
    @CurrentActor() actor: Actor,
  ): Promise<SalarySheetDto> {
    const rule: BulkApplyComponents = { ...body.apply, employeeIds: body.employeeIds };
    await this.service.applyBulkComponents(id, rule, body.version, actor);
    return this.require(id, true, actor);
  }

  @Post(':id/post')
  @HttpCode(200)
  @Roles({ module: 'HR', action: 'POST' })
  post(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PostSalaryDto,
    @CurrentActor() actor: Actor,
  ): Promise<PostSalaryResult> {
    return this.service.post(id, body.version, actor);
  }

  @Post(':id/reverse')
  @HttpCode(200)
  @Roles({ module: 'HR', action: 'CANCEL' })
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReverseSalaryDto,
    @CurrentActor() actor: Actor,
  ): Promise<ReverseSalaryResult> {
    return this.service.reverse(id, body.reason, actor);
  }

  @Get(':id/payslips')
  @Roles({ module: 'HR', action: 'READ' })
  payslipsFor(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('employeeId') employeeId: string | undefined,
    @CurrentActor() actor: Actor,
  ): Promise<Payslip[]> {
    return this.payslips.forSheet(id, employeeId, actor);
  }

  private async require(id: string, includeLines: boolean, actor: Actor): Promise<SalarySheetDto> {
    const dto = await this.query.getSalarySheet(id, includeLines, actor);
    if (!dto) throw new NotFoundException(`Salary sheet ${id} not found`);
    return dto;
  }
}
