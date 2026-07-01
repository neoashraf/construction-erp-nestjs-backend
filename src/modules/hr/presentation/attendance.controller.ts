/**
 * AttendanceController — `/api/attendance/*` (FR-HR-004..012). Three-mode capture (office / subcontractor /
 * daily-labour), bulk-capable, biometric import, and the daily-labour accrual lifecycle (confirm/reverse).
 * camelCase JSON + `{data,meta}` envelope + canonical/module error codes. The daily-labour accrual posts
 * via the internal PostingService — there is NO `POST /api/ledger`; the ledger impact is triggered by
 * `.../daily-labour/:id/confirm` only. Subcontractor capture posts NOTHING (no `.../confirm` for it).
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
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
import { Type } from 'class-transformer';
import { Actor } from '../../../core/tenancy/tenant-context';
import { CurrentActor } from '../../../core/auth/presentation/current-actor.decorator';
import { Paginated } from '../../../infrastructure/http/pagination';
import {
  AttendanceService,
  BiometricImportResult,
  ConfirmResult,
  ReverseResult,
} from '../application/attendance.service';
import { AttendanceDto, HrQueryService } from '../application/hr-query.service';
import { NewAttendance } from '../domain/attendance-record';

class OfficeRowDto {
  @IsUUID() employeeId!: string;
  @IsDateString() attendanceDate!: string;
  @IsUUID() projectId!: string;
  @IsOptional() @IsString() checkIn?: string;
  @IsOptional() @IsString() checkOut?: string;
  @IsIn(['PRESENT', 'PAID_LEAVE', 'UNPAID_LEAVE', 'ABSENT']) dayStatus!: string;
  @IsOptional() @IsNumberString() overtimeHours?: string;
}

class OfficeCaptureDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => OfficeRowDto) rows!: OfficeRowDto[];
}

class SubcontractorRowDto {
  @IsUUID() partyId!: string;
  @IsDateString() attendanceDate!: string;
  @IsUUID() projectId!: string;
  @IsUUID() costCentreId!: string;
  @IsOptional() @IsUUID() purposeId?: string;
  @IsInt() @Min(1) headCount!: number;
}

class SubcontractorCaptureDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => SubcontractorRowDto) rows!: SubcontractorRowDto[];
}

class DailyLabourRowDto {
  @IsDateString() attendanceDate!: string;
  @IsUUID() projectId!: string;
  @IsUUID() costCentreId!: string;
  @IsOptional() @IsUUID() purposeId?: string;
  @IsOptional() @IsString() labourCategory?: string;
  @IsInt() @Min(1) headCount!: number;
  @IsNumberString() dailyRate!: string;
}

class DailyLabourCaptureDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => DailyLabourRowDto) rows!: DailyLabourRowDto[];
}

class EditDailyLabourDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsInt() @Min(1) headCount?: number;
  @IsOptional() @IsNumberString() dailyRate?: string;
  @IsOptional() @IsString() labourCategory?: string;
  @IsOptional() @IsUUID() purposeId?: string;
}

class ConfirmDto {
  @IsOptional() @IsInt() @Min(1) version?: number;
  @IsOptional() @IsUUID() purposeId?: string;
}

class ReverseDto {
  @IsString() reason!: string;
}

class BiometricImportDto {
  @IsUUID() projectId!: string;
  @IsOptional() @IsArray() deviceFeed?: unknown[];
  /** Base64-encoded CSV/XLSX content (multipart file support is added when the upload pipe lands). */
  @IsOptional() @IsString() fileBase64?: string;
  @IsOptional() @IsString() fileName?: string;
}

class AttendanceQueryDto {
  @IsOptional() @IsIn(['OFFICE', 'SUBCONTRACTOR', 'DAILY_LABOUR']) mode?: string;
  @IsOptional() @IsDateString() attendanceDate?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() costCentreId?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsUUID() partyId?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() isConfirmed?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

@ApiTags('HR / Attendance')
@Controller('api/attendance')
export class AttendanceController {
  constructor(
    private readonly service: AttendanceService,
    private readonly query: HrQueryService,
  ) {}

  @Get()
  list(
    @Query() q: AttendanceQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<Paginated<AttendanceDto>> {
    return this.query.listAttendance(q, actor);
  }

  @Post('office')
  @HttpCode(201)
  captureOffice(
    @Body() body: OfficeCaptureDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ ids: string[] }> {
    return this.service.capture('OFFICE', body.rows as unknown as NewAttendance[], actor);
  }

  @Post('office/import')
  @HttpCode(200)
  importBiometric(
    @Body() body: BiometricImportDto,
    @CurrentActor() actor: Actor,
  ): Promise<BiometricImportResult> {
    const file = body.fileBase64 ? Buffer.from(body.fileBase64, 'base64') : undefined;
    return this.service.importBiometric(
      { file, fileName: body.fileName, deviceFeed: body.deviceFeed as never },
      body.projectId,
      actor,
    );
  }

  @Post('subcontractor')
  @HttpCode(201)
  captureSubcontractor(
    @Body() body: SubcontractorCaptureDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ ids: string[] }> {
    return this.service.capture('SUBCONTRACTOR', body.rows as unknown as NewAttendance[], actor);
  }

  @Post('daily-labour')
  @HttpCode(201)
  captureDailyLabour(
    @Body() body: DailyLabourCaptureDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ ids: string[] }> {
    return this.service.capture('DAILY_LABOUR', body.rows as unknown as NewAttendance[], actor);
  }

  @Patch('daily-labour/:id')
  async editDailyLabour(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EditDailyLabourDto,
    @CurrentActor() actor: Actor,
  ): Promise<AttendanceDto> {
    const { version, ...patch } = body;
    await this.service.editDailyLabour(id, patch, version, actor);
    return this.requireAttendance(id, actor);
  }

  @Post('daily-labour/:id/confirm')
  @HttpCode(200)
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ConfirmDto,
    @CurrentActor() actor: Actor,
  ): Promise<ConfirmResult> {
    return this.service.confirmDailyLabour(id, body.purposeId, actor);
  }

  @Post('daily-labour/:id/reverse')
  @HttpCode(200)
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReverseDto,
    @CurrentActor() actor: Actor,
  ): Promise<ReverseResult> {
    return this.service.reverseAccrual(id, body.reason, actor);
  }

  private async requireAttendance(id: string, actor: Actor): Promise<AttendanceDto> {
    const dto = await this.query.getAttendance(id, actor);
    if (!dto) throw new NotFoundException(`Attendance ${id} not found`);
    return dto;
  }
}
