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
import { AttendanceReportService } from '../attendance-reports/application/attendance-report.service';
import { ATTENDANCE_REPORT_READ_PORT } from '../attendance-reports/domain/ports/attendance-report.read.port';
import { AttendanceReportReadAdapter } from '../attendance-reports/infrastructure/attendance-report.read.adapter';
import { AttendanceReportController } from '../attendance-reports/presentation/attendance-report.controller';
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
    // use cases
    EmployeeService,
    AttendanceService,
    SalaryService,
    PayslipService,
    // read
    HrQueryService,
    AttendanceReportService,
  ],
})
export class HrModule {}
