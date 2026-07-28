/**
 * HrModule (HR) — composition root for the people-and-attendance + office-payroll halves. Binds the HR
 * ports → adapters and wires the employee + attendance + salary controllers. Imports PostingModule (the
 * single ledger writer, exported by core) and AuthModule. HR posts the daily-labour accrual AND the
 * office-staff SALARY entry through the REAL PostingService inside its own UnitOfWork (via HR's own
 * PostingServicePort seam); it never writes journal_entry/journal_line directly (CLAUDE.md 1–2;
 * FR-HR-009/-015).
 *
 * SEAMS: the MAS ports (HrAccountResolverPort → CoA codes / hr_account_config, HrProjectStatusPort →
 * project.status) are bound to adapters that read MAS `account`/`project` + HR's own `hr_account_config`
 * directly (MAS exports no repositories to HR). Rebind when MAS exports an account-role / project-status
 * service. AUDIT_SERVICE + UNIT_OF_WORK + CLOCK + ID_GENERATOR are provided globally.
 */
import { Module } from '@nestjs/common';
import { PostingModule } from '../../../core/posting/posting.module';
import { AuthModule } from '../../../core/auth/auth.module';
import { PaymentModule } from '../../payment/presentation/payment.module';
import { EmployeeService } from '../application/employee.service';
import { AttendanceService } from '../application/attendance.service';
import { SalaryService } from '../application/salary.service';
import { PayslipService } from '../application/payslip.service';
import { HrQueryService } from '../application/hr-query.service';
import { EMPLOYEE_REPOSITORY } from '../domain/ports/employee.repository';
import { ATTENDANCE_REPOSITORY } from '../domain/ports/attendance.repository';
import { LABOUR_PAYABLE_REPOSITORY } from '../domain/ports/labour-payable.repository';
import { SALARY_SHEET_REPOSITORY } from '../domain/ports/salary-sheet.repository';
import { HR_ACCOUNT_RESOLVER_PORT } from '../domain/ports/hr-account-resolver.port';
import { HR_PROJECT_STATUS_PORT } from '../domain/ports/project-status.port';
import { POSTING_SERVICE_PORT } from '../domain/ports/posting.service.port';
import { BIOMETRIC_IMPORT_PORT } from '../domain/ports/biometric-import.port';
import { TypeOrmEmployeeRepository } from '../infrastructure/typeorm-employee.repository';
import { TypeOrmAttendanceRepository } from '../infrastructure/typeorm-attendance.repository';
import { TypeOrmLabourPayableRepository } from '../infrastructure/typeorm-labour-payable.repository';
import { TypeOrmSalarySheetRepository } from '../infrastructure/typeorm-salary-sheet.repository';
import { HrAccountResolverAdapter } from '../infrastructure/hr-account-resolver.adapter';
import { HrProjectStatusAdapter } from '../infrastructure/hr-project-status.adapter';
import { PostingServiceAdapter } from '../infrastructure/posting-service.adapter';
import { CsvBiometricImportAdapter } from '../infrastructure/biometric-import.adapter';
import { AttendanceLogService } from '../attendance-reports/application/attendance-log.service';
import { AttendanceReportService } from '../attendance-reports/application/attendance-report.service';
import { AttendanceSettingService } from '../attendance-reports/application/attendance-setting.service';
import { HolidayService } from '../attendance-reports/application/holiday.service';
import { ATTENDANCE_LOG_READ_PORT } from '../attendance-reports/domain/ports/attendance-log.read.port';
import { ATTENDANCE_REPORT_READ_PORT } from '../attendance-reports/domain/ports/attendance-report.read.port';
import { ATTENDANCE_CONFIG_REPOSITORY } from '../attendance-reports/domain/ports/attendance-config.repository';
import { PUBLIC_HOLIDAY_API_PORT } from '../attendance-reports/domain/ports/public-holiday-api.port';
import { AttendanceLogReadAdapter } from '../attendance-reports/infrastructure/attendance-log.read.adapter';
import { AttendanceReportReadAdapter } from '../attendance-reports/infrastructure/attendance-report.read.adapter';
import { TypeOrmAttendanceConfigRepository } from '../attendance-reports/infrastructure/typeorm-attendance-config.repository';
import { NagerPublicHolidayAdapter } from '../attendance-reports/infrastructure/nager-public-holiday.adapter';
import { AttendanceImportService } from '../attendance-reports/application/attendance-import.service';
import { AttendanceUserService } from '../attendance-reports/application/attendance-user.service';
import { AttendanceDeviceService } from '../attendance-reports/application/attendance-device.service';
import { DeviceAutoSyncService } from '../attendance-reports/application/device-auto-sync.service';
import { DeviceIngestionService } from '../attendance-reports/application/device-ingestion.service';
import { DeviceStatusService } from '../attendance-reports/application/device-status.service';
import { DeviceSyncService } from '../attendance-reports/application/device-sync.service';
import { DEVICE_PULLER } from '../attendance-reports/domain/ports/device-puller.port';
import { ZkDevicePullerAdapter } from '../attendance-reports/infrastructure/zk-device-puller.adapter';
import { ATTENDANCE_USER_REPOSITORY } from '../attendance-reports/domain/ports/attendance-user.repository';
import { ATTENDANCE_DEVICE_REPOSITORY } from '../attendance-reports/domain/ports/attendance-device.repository';
import { PUNCH_INGESTION_REPOSITORY } from '../attendance-reports/domain/ports/punch-ingestion.repository';
import { TypeOrmAttendanceUserRepository } from '../attendance-reports/infrastructure/typeorm-attendance-user.repository';
import { TypeOrmAttendanceDeviceRepository } from '../attendance-reports/infrastructure/typeorm-attendance-device.repository';
import { TypeOrmPunchIngestionRepository } from '../attendance-reports/infrastructure/typeorm-punch-ingestion.repository';
import { AttendanceLogController } from '../attendance-reports/presentation/attendance-log.controller';
import { AttendanceReportController } from '../attendance-reports/presentation/attendance-report.controller';
import { AttendanceSettingController } from '../attendance-reports/presentation/attendance-setting.controller';
import { AttendanceUserController } from '../attendance-reports/presentation/attendance-user.controller';
import { AttendanceDeviceController } from '../attendance-reports/presentation/attendance-device.controller';
import {
  DeviceIngestionController,
  DeviceStatusController,
} from '../attendance-reports/presentation/device.controller';
import { HolidayController } from '../attendance-reports/presentation/holiday.controller';
import { EmployeeController } from './employee.controller';
import { AttendanceController } from './attendance.controller';
import { SalaryController } from './salary.controller';

@Module({
  imports: [PostingModule, AuthModule, PaymentModule],
  controllers: [
    EmployeeController,
    AttendanceController,
    SalaryController,
    // `/api/reports/{daily,range,summary}` — HR owns employee + attendance_record, so the attendance
    // reports are wired here even though they share RPT's `/api/reports` path prefix.
    AttendanceReportController,
    // `/api/logs` — the DEVICE-LOG view over raw punches; sibling of /api/reports/range (§2).
    AttendanceLogController,
    // The report CONFIGURATION surface: without these the late threshold and the holiday calendar can
    // never be changed, and every weekend counts as a working day.
    AttendanceSettingController,
    HolidayController,
    // Device→employee mapping the reports are built from (§7).
    AttendanceUserController,
    AttendanceDeviceController,
    // Fingerprint device: UNAUTHENTICATED `/iclock/cdata` ingestion + guarded status/sync (§4, §5).
    DeviceIngestionController,
    DeviceStatusController,
  ],
  providers: [
    // ports → adapters
    { provide: EMPLOYEE_REPOSITORY, useClass: TypeOrmEmployeeRepository },
    { provide: ATTENDANCE_REPOSITORY, useClass: TypeOrmAttendanceRepository },
    { provide: LABOUR_PAYABLE_REPOSITORY, useClass: TypeOrmLabourPayableRepository },
    { provide: SALARY_SHEET_REPOSITORY, useClass: TypeOrmSalarySheetRepository },
    { provide: HR_ACCOUNT_RESOLVER_PORT, useClass: HrAccountResolverAdapter },
    { provide: HR_PROJECT_STATUS_PORT, useClass: HrProjectStatusAdapter },
    { provide: POSTING_SERVICE_PORT, useClass: PostingServiceAdapter },
    { provide: BIOMETRIC_IMPORT_PORT, useClass: CsvBiometricImportAdapter },
    { provide: ATTENDANCE_REPORT_READ_PORT, useClass: AttendanceReportReadAdapter },
    { provide: ATTENDANCE_LOG_READ_PORT, useClass: AttendanceLogReadAdapter },
    { provide: ATTENDANCE_CONFIG_REPOSITORY, useClass: TypeOrmAttendanceConfigRepository },
    { provide: PUBLIC_HOLIDAY_API_PORT, useClass: NagerPublicHolidayAdapter },
    { provide: ATTENDANCE_USER_REPOSITORY, useClass: TypeOrmAttendanceUserRepository },
    { provide: ATTENDANCE_DEVICE_REPOSITORY, useClass: TypeOrmAttendanceDeviceRepository },
    { provide: PUNCH_INGESTION_REPOSITORY, useClass: TypeOrmPunchIngestionRepository },
    { provide: DEVICE_PULLER, useClass: ZkDevicePullerAdapter },
    // use cases
    EmployeeService,
    AttendanceService,
    SalaryService,
    PayslipService,
    // read
    HrQueryService,
    AttendanceReportService,
    AttendanceLogService,
    AttendanceSettingService,
    HolidayService,
    AttendanceUserService,
    AttendanceDeviceService,
    DeviceAutoSyncService,
    DeviceIngestionService,
    // Default (singleton) scope is REQUIRED — a request-scoped instance would forget the last heartbeat.
    DeviceStatusService,
    // Singleton for the same reason, plus its in-progress flag: a request-scoped instance
    // would give every caller a fresh flag, defeating the one-sync-at-a-time guard.
    DeviceSyncService,
    AttendanceImportService,
  ],
})
export class HrModule {}
