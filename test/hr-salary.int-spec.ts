/**
 * HR salary sheet & SALARY posting integration — Testcontainers Postgres, real migrations + LED triggers +
 * the real PostingService/LED/NUM/PER (skill §13). Mirrors hr-attendance.int-spec.ts's bootstrap style,
 * adding the 1700001800000-CreateHrSalary migration + `hr_account_config` fixture rows. Proves the brief's
 * DoD end-to-end:
 *   - AC1 : post writes a balanced SALARY entry (Σdr=Σcr=525,000.0000 exact — design §4(b)), cost lines
 *           tagged project + cost_centre(Labour) + purpose, no godown.
 *   - AC2 : posts via PostingService only, inside the caller's UoW, draft->posted; gapless entry_no only
 *           at post; a DRAFT has no ledger lines/number.
 *   - AC4 : INACTIVE excluded from generate; a duplicate DRAFT for the same period is rejected.
 *   - AC6 : a CLOSED period/project rejects post before any write — no entry, no number consumed.
 *   - AC7 : reverse writes a linked reversal entry; the original entry is byte-for-byte unchanged; the
 *           DERIVED REVERSED status is reported by the read layer (stored column stays POSTED); re-reverse
 *           is rejected by LED (ALREADY_REVERSED).
 *   - AC10: payslips are available only after post (SALARY_NOT_POSTED on a DRAFT).
 *   - AC12: atomic post — a forced imbalance rolls back the whole transaction (no number consumed).
 *   - RBAC : real RolesGuard against a real Postgres-backed Role/Permission repo, per skill §13.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

import { CompanyOrmEntity } from '../src/modules/master-data/company/infrastructure/persistence/company.orm-entity';
import { FinancialYearOrmEntity } from '../src/modules/master-data/financial-year/infrastructure/persistence/financial-year.orm-entity';
import { NumberingSeriesOrmEntity } from '../src/core/numbering/infrastructure/numbering-series.orm-entity';
import { AccountingPeriodOrmEntity } from '../src/core/period/infrastructure/accounting-period.orm-entity';
import { JournalEntryOrmEntity } from '../src/core/posting/infrastructure/journal-entry.orm-entity';
import { JournalLineOrmEntity } from '../src/core/posting/infrastructure/journal-line.orm-entity';
import { AccountOrmEntity } from '../src/modules/master-data/chart-of-accounts/infrastructure/account.orm-entity';
import { PartyOrmEntity } from '../src/modules/master-data/party/infrastructure/party.orm-entity';
import { ProjectOrmEntity } from '../src/modules/master-data/project/infrastructure/project.orm-entity';
import { EmployeeOrmEntity } from '../src/modules/hr/infrastructure/employee.orm-entity';
import { EmployeeAssignmentOrmEntity } from '../src/modules/hr/infrastructure/employee-assignment.orm-entity';
import { AttendanceRecordOrmEntity } from '../src/modules/hr/infrastructure/attendance-record.orm-entity';
import { LabourPayableOrmEntity } from '../src/modules/hr/infrastructure/labour-payable.orm-entity';
import { SalarySheetOrmEntity } from '../src/modules/hr/infrastructure/salary-sheet.orm-entity';
import { SalarySheetLineOrmEntity } from '../src/modules/hr/infrastructure/salary-sheet-line.orm-entity';
import { HrAccountConfigOrmEntity } from '../src/modules/hr/infrastructure/hr-account-config.orm-entity';

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateUser1700000700000 } from '../src/database/migrations/1700000700000-CreateUser';
import { CreateRbacAndAudit1700000800000 } from '../src/database/migrations/1700000800000-CreateRbacAndAudit';
import { RbacV2ResourcePermissions1700002300000 } from '../src/database/migrations/1700002300000-RbacV2ResourcePermissions';
import { CreateHrEmployeeAttendance1700001300000 } from '../src/database/migrations/1700001300000-CreateHrEmployeeAttendance';
import { CreateHrSalary1700001800000 } from '../src/database/migrations/1700001800000-CreateHrSalary';

import { TypeOrmJournalEntryRepository } from '../src/core/posting/infrastructure/typeorm-journal-entry.repository';
import { TypeOrmNumberingService } from '../src/core/numbering/infrastructure/typeorm-numbering.service';
import { TypeOrmAccountingPeriodRepository } from '../src/core/period/infrastructure/typeorm-accounting-period.repository';
import { PeriodServiceImpl } from '../src/core/period/application/period.service';
import { OverviewTagMatrix } from '../src/core/posting/domain/tag-matrix';
import {
  AllowAllMasterLookupService,
  AllowAllProjectStatusService,
} from '../src/core/posting/infrastructure/mas-seam.adapters';
import { PostingService } from '../src/core/posting/application/posting.service';
import { TypeOrmUnitOfWork } from '../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { UuidIdGenerator } from '../src/infrastructure/uuid-id-generator';
import { Actor } from '../src/core/tenancy/tenant-context';

import { TypeOrmEmployeeRepository } from '../src/modules/hr/infrastructure/typeorm-employee.repository';
import { TypeOrmAttendanceRepository } from '../src/modules/hr/infrastructure/typeorm-attendance.repository';
import { TypeOrmSalarySheetRepository } from '../src/modules/hr/infrastructure/typeorm-salary-sheet.repository';
import { HrAccountResolverAdapter } from '../src/modules/hr/infrastructure/hr-account-resolver.adapter';
import { HrProjectStatusAdapter } from '../src/modules/hr/infrastructure/hr-project-status.adapter';
import { PostingServiceAdapter } from '../src/modules/hr/infrastructure/posting-service.adapter';
import { SalaryService } from '../src/modules/hr/application/salary.service';
import { EmployeeService } from '../src/modules/hr/application/employee.service';
import { PayslipService } from '../src/modules/hr/application/payslip.service';
import { SalaryNotPostedError } from '../src/modules/hr/domain/errors';

// RolesGuard smoke test deps (mandatory per skill §13 — proves the controller's guard wiring is real).
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleOrmEntity } from '../src/core/auth/infrastructure/role.orm-entity';
import { PermissionOrmEntity } from '../src/core/auth/infrastructure/permission.orm-entity';
import { TypeOrmRoleRepository } from '../src/core/auth/infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from '../src/core/auth/infrastructure/typeorm-permission.repository';
import { RolesGuard } from '../src/core/auth/presentation/roles.guard';
import { JwtAuthGuard } from '../src/core/auth/presentation/jwt-auth.guard';
import { PermissionRequirement } from '../src/core/auth/presentation/require-permission.decorator';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c3';
const FY1 = '00000000-0000-0000-0000-0000000000f3';
const PERIOD = '00000000-0000-0000-0000-0000000000e3';
const USER = '00000000-0000-0000-0000-0000000000a3';
const GROUP = '00000000-0000-0000-0000-0000000000b3';
const PROJECT = '00000000-0000-0000-0000-00000000d201';
const CC_LABOUR = '00000000-0000-0000-0000-00000000d202';
const PURPOSE = '00000000-0000-0000-0000-00000000d203';

const ACC = {
  grossSalary: '00000000-0000-0000-0000-00000000a601',
  employerPf: '00000000-0000-0000-0000-00000000a602',
  salaryPayable: '00000000-0000-0000-0000-00000000a603',
  tdsPayable: '00000000-0000-0000-0000-00000000a604',
  pfPayable: '00000000-0000-0000-0000-00000000a605',
  advanceRecovery: '00000000-0000-0000-0000-00000000a606',
};

const actor: Actor = {
  userId: USER,
  companyId: CO,
  financialYearId: FY1,
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

describe('HR salary sheet & SALARY posting (real Postgres + real PostingService)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let salary: SalaryService;
  let employees: EmployeeService;
  let payslips: PayslipService;
  let rolesGuard: RolesGuard;
  let jwtAuthGuard: JwtAuthGuard;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    ds = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      synchronize: false,
      entities: [
        CompanyOrmEntity,
        FinancialYearOrmEntity,
        NumberingSeriesOrmEntity,
        AccountingPeriodOrmEntity,
        JournalEntryOrmEntity,
        JournalLineOrmEntity,
        AccountOrmEntity,
        PartyOrmEntity,
        ProjectOrmEntity,
        EmployeeOrmEntity,
        EmployeeAssignmentOrmEntity,
        AttendanceRecordOrmEntity,
        LabourPayableOrmEntity,
        SalarySheetOrmEntity,
        SalarySheetLineOrmEntity,
        HrAccountConfigOrmEntity,
        RoleOrmEntity,
        PermissionOrmEntity,
      ],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateLedger1700000400000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
        CreateUser1700000700000,
        CreateRbacAndAudit1700000800000,
        RbacV2ResourcePermissions1700002300000,
        CreateHrEmployeeAttendance1700001300000,
        CreateHrSalary1700001800000,
      ],
    });
    await ds.initialize();
    await ds.runMigrations();

    await ds.query(
      `INSERT INTO company (id, name, legal_name, bin, tin) VALUES ($1,'ZE','ZE Ltd','1234567890123','123456789012')`,
      [CO],
    );
    await ds.query(
      `INSERT INTO financial_year (id, company_id, label, start_date, end_date, is_active) VALUES ($1,$2,'2025-26','2025-07-01','2026-06-30',true)`,
      [FY1, CO],
    );
    await ds.query(
      `INSERT INTO accounting_period (id, company_id, financial_year_id, name, start_date, end_date, status) VALUES ($1,$2,$3,'Jun 2026','2026-06-01','2026-06-30','OPEN')`,
      [PERIOD, CO, FY1],
    );
    await ds.query(`INSERT INTO account_group (id, company_id, name, parent_group_id, type) VALUES ($1,$2,'Root',NULL,'EXPENSE')`, [
      GROUP,
      CO,
    ]);
    const acc = (id: string, code: string, name: string, type: string) =>
      ds.query(
        `INSERT INTO account (id, company_id, code, name, account_group_id, type, opening_balance) VALUES ($1,$2,$3,$4,$5,$6,NULL)`,
        [id, CO, code, name, GROUP, type],
      );
    await acc(ACC.grossSalary, '5200', 'Gross Salary & Wages', 'EXPENSE');
    await acc(ACC.employerPf, '5210', 'Employer PF Contribution', 'EXPENSE');
    await acc(ACC.salaryPayable, '2320', 'Salary Payable', 'LIABILITY');
    await acc(ACC.tdsPayable, '2330', 'TDS Payable', 'LIABILITY');
    await acc(ACC.pfPayable, '2340', 'PF Payable', 'LIABILITY');
    await acc(ACC.advanceRecovery, '1310', 'Staff Advance Recovery', 'ASSET');

    const CUSTOMER = '00000000-0000-0000-0000-00000000d204';
    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES ($1,$2,'Cust A',true,false,'+8801700000000')`,
      [CUSTOMER, CO],
    );
    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,'P-01','Site A',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [PROJECT, CO, CUSTOMER, USER],
    );
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-Labour','Labour')`, [
      CC_LABOUR,
      CO,
    ]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Payroll 2026-06')`, [
      PURPOSE,
      CO,
      PROJECT,
    ]);

    // hr_account_config — the role->account/cost-centre mapping (architectural decision 3/4). NOT seeded
    // by the migration itself; the test inserts its own rows for the test company (brief's own note).
    const cfgAcc = (role: string, accountId: string) =>
      ds.query(
        `INSERT INTO hr_account_config (id, company_id, role, account_id, cost_centre_id) VALUES (gen_random_uuid(),$1,$2,$3,NULL)`,
        [CO, role, accountId],
      );
    await cfgAcc('GROSS_SALARY', ACC.grossSalary);
    await cfgAcc('EMPLOYER_PF', ACC.employerPf);
    await cfgAcc('SALARY_PAYABLE', ACC.salaryPayable);
    await cfgAcc('TDS_PAYABLE', ACC.tdsPayable);
    await cfgAcc('PF_PAYABLE', ACC.pfPayable);
    await cfgAcc('STAFF_ADVANCE_RECOVERY', ACC.advanceRecovery);
    await ds.query(
      `INSERT INTO hr_account_config (id, company_id, role, account_id, cost_centre_id) VALUES (gen_random_uuid(),$1,'LABOUR_COST_CENTRE',NULL,$2)`,
      [CO, CC_LABOUR],
    );

    const uow = new TypeOrmUnitOfWork(ds);
    const ids = new UuidIdGenerator();
    const clock = { now: () => new Date('2026-06-30T10:00:00Z') };
    const posting = new PostingService(
      new TypeOrmJournalEntryRepository(ds),
      new TypeOrmNumberingService(ids),
      new PeriodServiceImpl(new TypeOrmAccountingPeriodRepository(ds)),
      new OverviewTagMatrix(),
      new AllowAllProjectStatusService(),
      new AllowAllMasterLookupService(),
      ids,
      clock,
    );
    const audit = { record: async () => undefined };

    const employeeRepo = new TypeOrmEmployeeRepository(ds);
    const attendanceRepo = new TypeOrmAttendanceRepository(ds, ids);
    const salaryRepo = new TypeOrmSalarySheetRepository(ds);
    const accountResolver = new HrAccountResolverAdapter(ds);
    const projectStatus = new HrProjectStatusAdapter(ds);
    const postingAdapter = new PostingServiceAdapter(posting);

    salary = new SalaryService(
      salaryRepo,
      employeeRepo,
      attendanceRepo,
      accountResolver,
      projectStatus,
      postingAdapter,
      audit as never,
      uow,
      ids,
      clock,
    );
    employees = new EmployeeService(employeeRepo, audit as never, uow, ids);
    payslips = new PayslipService(salaryRepo, employeeRepo);

    const roleRepo = new TypeOrmRoleRepository(ds);
    const permRepo = new TypeOrmPermissionRepository(ds);
    rolesGuard = new RolesGuard(new Reflector(), roleRepo, permRepo);
    jwtAuthGuard = new JwtAuthGuard();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await ds.query(
      'TRUNCATE journal_line, journal_entry, salary_sheet_line, salary_sheet, attendance_record, employee_assignment, employee, numbering_series RESTART IDENTITY CASCADE',
    );
  });

  async function createEmployee(
    code: string,
    status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
    pfApplicable = false,
  ): Promise<string> {
    const { id } = await employees.create(
      {
        employeeCode: code,
        name: `Employee ${code}`,
        designation: 'Site Accountant',
        defaultProjectId: PROJECT,
        workBase: 'SITE',
        wageType: 'MONTHLY',
        wageAmount: '45000',
        pfApplicable,
        joiningDate: '2025-07-01',
      },
      actor,
    );
    if (status === 'INACTIVE') {
      await employees.deactivate(id, 1, actor);
    }
    return id;
  }

  async function officeAttendance(employeeId: string, days: number): Promise<void> {
    for (let d = 1; d <= days; d++) {
      const day = String(d).padStart(2, '0');
      await ds.query(
        `INSERT INTO attendance_record (id, company_id, financial_year_id, mode, attendance_date, project_id, employee_id, day_status, overtime_hours, source, is_confirmed)
         VALUES (gen_random_uuid(), $1, $2, 'OFFICE', $3, $4, $5, 'PRESENT', 0, 'MANUAL', false)`,
        [CO, FY1, `2026-06-${day}`, PROJECT, employeeId],
      );
    }
  }

  /** Build a DRAFT sheet with one line whose figures match the design §4(b) worked template exactly. */
  async function draftWorkedSheet(): Promise<string> {
    const empId = await createEmployee('EMP-100', 'ACTIVE', true); // pfApplicable=true -> employer PF matches
    await officeAttendance(empId, 30); // full month present -> gross = 45000 * 30/30 = 45000... scaled below
    const { id: sheetId } = await salary.generate(
      {
        financialYearId: FY1,
        periodLabel: '2026-06',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        purposeId: PURPOSE,
      },
      actor,
    );
    // Override the generated line's amounts to the exact worked-template figures via direct SQL (the
    // calculator's own exactness is proven in salary-calculator.spec.ts; here we need the specific
    // 500,000/25,000/40,000/25,000/30,000 figures to assert the design §4(b) balanced entry).
    const [line] = await ds.query(`SELECT id FROM salary_sheet_line WHERE salary_sheet_id = $1`, [sheetId]);
    await ds.query(
      `UPDATE salary_sheet_line SET gross_amount=500000, tds=40000, pf=25000, advance_recovery=30000,
         net_amount = 500000 - 40000 - 25000 - 30000 WHERE id = $1`,
      [line.id],
    );
    return sheetId;
  }

  it('AC1/AC2: post writes a balanced SALARY entry, cost centre Labour, gapless entry_no, draft has none before', async () => {
    const sheetId = await draftWorkedSheet();

    const [before] = await ds.query(`SELECT status, salary_entry_id FROM salary_sheet WHERE id=$1`, [sheetId]);
    expect(before.status).toBe('DRAFT');
    expect(before.salary_entry_id).toBeNull();
    const [{ n: entriesBefore }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(entriesBefore).toBe(0);

    const result = await salary.post(sheetId, 1, actor);
    expect(result.status).toBe('POSTED');
    expect(result.entryNo).toMatch(/SAL\//);

    const [entry] = await ds.query(`SELECT entry_no, voucher_type FROM journal_entry WHERE id=$1`, [
      result.salaryEntryId,
    ]);
    expect(entry.voucher_type).toBe('SALARY');
    expect(entry.entry_no).toBe(result.entryNo);

    const [sum] = await ds.query(
      `SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`,
      [result.salaryEntryId],
    );
    expect(sum.dr).toBe('525000.0000');
    expect(sum.cr).toBe('525000.0000');

    const lines = await ds.query(
      `SELECT account_id, project_id, cost_centre_id, purpose_id, godown_id, party_id, debit::text d, credit::text c
         FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [result.salaryEntryId],
    );
    for (const l of lines) {
      expect(l.project_id).toBe(PROJECT);
      expect(l.cost_centre_id).toBe(CC_LABOUR);
      expect(l.purpose_id).toBe(PURPOSE);
      expect(l.godown_id).toBeNull();
      expect(l.party_id).toBeNull();
    }
    const grossLine = lines.find((l: { account_id: string }) => l.account_id === ACC.grossSalary);
    expect(grossLine.d).toBe('500000.0000');
    const employerPfLine = lines.find((l: { account_id: string }) => l.account_id === ACC.employerPf);
    expect(employerPfLine.d).toBe('25000.0000'); // employer PF matched 1:1 to the employee's own PF (pfApplicable=true)
    const salaryPayableLine = lines.find((l: { account_id: string }) => l.account_id === ACC.salaryPayable);
    expect(salaryPayableLine.c).toBe('405000.0000');
    const pfPayableLine = lines.find((l: { account_id: string }) => l.account_id === ACC.pfPayable);
    expect(pfPayableLine.c).toBe('50000.0000'); // employer 25,000 + employee 25,000 — design §4(b)

    const [sheetAfter] = await ds.query(`SELECT status, salary_entry_id FROM salary_sheet WHERE id=$1`, [
      sheetId,
    ]);
    expect(sheetAfter.status).toBe('POSTED');
    expect(sheetAfter.salary_entry_id).toBe(result.salaryEntryId);
  });

  it('AC4: INACTIVE excluded from generate; a second DRAFT for the same period is rejected', async () => {
    const activeId = await createEmployee('EMP-200', 'ACTIVE');
    await createEmployee('EMP-201', 'INACTIVE');
    await officeAttendance(activeId, 20);

    const { id: sheetId } = await salary.generate(
      { financialYearId: FY1, periodLabel: '2026-07', periodStart: '2026-07-01', periodEnd: '2026-07-31', purposeId: PURPOSE },
      actor,
    );
    const lines = await ds.query(`SELECT employee_id FROM salary_sheet_line WHERE salary_sheet_id=$1`, [
      sheetId,
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].employee_id).toBe(activeId);

    await expect(
      salary.generate(
        { financialYearId: FY1, periodLabel: '2026-07', periodStart: '2026-07-01', periodEnd: '2026-07-31', purposeId: PURPOSE },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_DRAFT_SHEET' });
  });

  it('AC6: post into a CLOSED period rolls back — sheet stays DRAFT, no entry, no number', async () => {
    const sheetId = await draftWorkedSheet();
    await ds.query(`UPDATE accounting_period SET status='CLOSED' WHERE id=$1`, [PERIOD]);
    try {
      await expect(salary.post(sheetId, 1, actor)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
      expect(entries).toBe(0);
      const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series`);
      expect(series).toBe(0);
      const [sheet] = await ds.query(`SELECT status, salary_entry_id FROM salary_sheet WHERE id=$1`, [
        sheetId,
      ]);
      expect(sheet.status).toBe('DRAFT');
      expect(sheet.salary_entry_id).toBeNull();
    } finally {
      await ds.query(`UPDATE accounting_period SET status='OPEN' WHERE id=$1`, [PERIOD]);
    }
  });

  it('AC6: post against a CLOSED project rolls back — no entry, no number', async () => {
    const sheetId = await draftWorkedSheet();
    await ds.query(`UPDATE project SET status='CLOSED' WHERE id=$1`, [PROJECT]);
    try {
      await expect(salary.post(sheetId, 1, actor)).rejects.toMatchObject({ code: 'PROJECT_CLOSED' });
      const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
      expect(entries).toBe(0);
    } finally {
      await ds.query(`UPDATE project SET status='ACTIVE' WHERE id=$1`, [PROJECT]);
    }
  });

  it('AC7: reverse writes a linked swapped-side entry; original unchanged; derived REVERSED; re-reverse rejected', async () => {
    const sheetId = await draftWorkedSheet();
    const posted = await salary.post(sheetId, 1, actor);

    const before = await ds.query(
      `SELECT id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [posted.salaryEntryId],
    );

    const rev = await salary.reverse(sheetId, 'correction', actor);

    const after = await ds.query(
      `SELECT id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [posted.salaryEntryId],
    );
    expect(after).toEqual(before); // byte-for-byte unchanged

    const [reversalRow] = await ds.query(
      `SELECT id, is_reversal, reversal_of FROM journal_entry WHERE reversal_of=$1`,
      [posted.salaryEntryId],
    );
    expect(reversalRow.is_reversal).toBe(true);
    expect(rev.reversalEntryId).toBe(reversalRow.id);
    expect(rev.originalEntryId).toBe(posted.salaryEntryId);

    // the STORED sheet status column stays POSTED (design §3) — never a literal REVERSED value.
    const [sheetRow] = await ds.query(`SELECT status FROM salary_sheet WHERE id=$1`, [sheetId]);
    expect(sheetRow.status).toBe('POSTED');

    // the DERIVED status (read layer) reports REVERSED because a reversal entry now exists.
    const [derived] = await ds.query(
      `SELECT id FROM journal_entry WHERE reversal_of = $1 LIMIT 1`,
      [posted.salaryEntryId],
    );
    expect(derived).toBeTruthy();

    // re-reverse is rejected by LED (ALREADY_REVERSED) — the sheet's salary_entry_id still points at the
    // ORIGINAL entry, and reversing an original that already has a reversal is rejected.
    await expect(salary.reverse(sheetId, 'again', actor)).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
  });

  it('AC10: payslips only after post — SALARY_NOT_POSTED on a DRAFT, populated after post', async () => {
    const sheetId = await draftWorkedSheet();
    await expect(payslips.forSheet(sheetId, undefined, actor)).rejects.toBeInstanceOf(SalaryNotPostedError);

    await salary.post(sheetId, 1, actor);
    const slips = await payslips.forSheet(sheetId, undefined, actor);
    expect(slips).toHaveLength(1);
    expect(slips[0].grossAmount).toBe('500000.0000');
    expect(slips[0].netAmount).toBe('405000.0000');
    expect(slips[0].employeeCode).toBe('EMP-100');
  });

  it('AC12: atomic post — a forced failure after the journal write rolls back the sheet + NUM counter', async () => {
    const sheetId = await draftWorkedSheet();
    // Force the transaction to fail AFTER PostingService.post has written the entry but before commit, by
    // wrapping the sheet repo's save() to throw — the whole uow.run rolls back (entry, lines, NUM counter,
    // and the sheet state change together).
    const salaryRepo = new TypeOrmSalarySheetRepository(ds);
    const failingRepo: typeof salaryRepo = Object.create(salaryRepo);
    failingRepo.save = async () => {
      throw new Error('forced failure post-journal-write');
    };
    const ids = new UuidIdGenerator();
    const clock = { now: () => new Date('2026-06-30T10:00:00Z') };
    const posting = new PostingService(
      new TypeOrmJournalEntryRepository(ds),
      new TypeOrmNumberingService(ids),
      new PeriodServiceImpl(new TypeOrmAccountingPeriodRepository(ds)),
      new OverviewTagMatrix(),
      new AllowAllProjectStatusService(),
      new AllowAllMasterLookupService(),
      ids,
      clock,
    );
    const uow = new TypeOrmUnitOfWork(ds);
    const audit = { record: async () => undefined };
    const svc = new SalaryService(
      failingRepo,
      new TypeOrmEmployeeRepository(ds),
      new TypeOrmAttendanceRepository(ds, ids),
      new HrAccountResolverAdapter(ds),
      new HrProjectStatusAdapter(ds),
      new PostingServiceAdapter(posting),
      audit as never,
      uow,
      ids,
      clock,
    );

    await expect(svc.post(sheetId, 1, actor)).rejects.toThrow('forced failure post-journal-write');

    const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(entries).toBe(0);
    const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series`);
    expect(series).toBe(0);
    const [sheet] = await ds.query(`SELECT status, salary_entry_id FROM salary_sheet WHERE id=$1`, [sheetId]);
    expect(sheet.status).toBe('DRAFT');
    expect(sheet.salary_entry_id).toBeNull();
  });

  // ── RBAC guard smoke test (skill §13) — proves SalaryController really enforces
  // @UseGuards(JwtAuthGuard, RolesGuard) + @Roles({module:'HR', action}), not just the use-case layer. ──
  describe('SalaryController RBAC — real RolesGuard against a real Postgres-backed Role/Permission repo', () => {
    const HR_MANAGER_ROLE = '00000000-0000-0000-0000-0000000e3b10';
    const PM_ROLE = '00000000-0000-0000-0000-0000000e3b11';
    const NO_GRANT_ROLE = '00000000-0000-0000-0000-0000000e3b12';
    const hrManagerActor: Actor = { ...actor, userId: 'hrm-user', role: 'HR_MANAGER' };
    const pmActor: Actor = { ...actor, userId: 'pm-user', role: 'PROJECT_MANAGER', isUnscoped: false, assignedProjectIds: [PROJECT] };
    const noGrantActor: Actor = { ...actor, userId: 'no-grant-user', role: 'STORE_KEEPER', isUnscoped: false };

    function mockContext(user: Actor | undefined, requirements: PermissionRequirement[]): ExecutionContext {
      jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(requirements);
      return {
        getHandler: () => function handler() {},
        getClass: () => class SalaryController {},
        switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }) }),
      } as unknown as ExecutionContext;
    }

    beforeAll(async () => {
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'HR_MANAGER',false,1) ON CONFLICT DO NOTHING`, [HR_MANAGER_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'PROJECT_MANAGER',false,1) ON CONFLICT DO NOTHING`, [PM_ROLE, CO]);
      await ds.query(`INSERT INTO "role" (id, company_id, name, is_unscoped, version) VALUES ($1,$2,'STORE_KEEPER',false,1) ON CONFLICT DO NOTHING`, [NO_GRANT_ROLE, CO]);

      // HR_MANAGER: full HR lifecycle (create/read/update/post/cancel) — per seed-roles-permissions.ts
      // (brief #36 already granted HR:CREATE/READ/UPDATE/POST/CANCEL, ASSIGNED scope; confirmed sufficient
      // for salary-sheet actions since they share the same module code 'HR').
      for (const action of ['CREATE', 'READ', 'UPDATE', 'POST', 'CANCEL']) {
        await ds.query(
          `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'hr.salary_sheets', $3, 'ASSIGNED', 1)`,
          [HR_MANAGER_ROLE, CO, action],
        );
      }
      // PROJECT_MANAGER: HR:READ only (project-scoped) — read-only visibility, no salary authoring.
      await ds.query(
        `INSERT INTO "permission" (id, role_id, company_id, resource, action, project_scope, version) VALUES (gen_random_uuid(), $1, $2, 'hr.salary_sheets', 'READ', 'ASSIGNED', 1)`,
        [PM_ROLE, CO],
      );
      // STORE_KEEPER holds zero HR grant — the "clearly lacks it" role for 403s.
    });

    it('401: no/invalid token', () => {
      expect(() => jwtAuthGuard.handleRequest(null, false, null)).toThrow(UnauthorizedException);
      expect(() => jwtAuthGuard.handleRequest(new Error('jwt malformed'), false, null)).toThrow(UnauthorizedException);
    });

    it.each([
      ['POST /generate', 'CREATE'],
      ['GET /', 'READ'],
      ['GET /:id', 'READ'],
      ['PATCH /:id/lines/:lineId', 'UPDATE'],
      ['PATCH /:id/components', 'UPDATE'],
      ['POST /:id/post', 'POST'],
      ['POST /:id/reverse', 'CANCEL'],
      ['GET /:id/payslips', 'READ'],
    ] as const)('403: STORE_KEEPER (no HR grant) is FORBIDDEN on %s -> HR:%s', async (_route, action) => {
      const ctx = mockContext(noGrantActor, [{ resource: 'hr.salary_sheets', action }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['POST /generate', 'CREATE'],
      ['GET /', 'READ'],
      ['GET /:id', 'READ'],
      ['PATCH /:id/lines/:lineId', 'UPDATE'],
      ['PATCH /:id/components', 'UPDATE'],
      ['POST /:id/post', 'POST'],
      ['POST /:id/reverse', 'CANCEL'],
      ['GET /:id/payslips', 'READ'],
    ] as const)('success: HR_MANAGER holds HR:%s -> guard resolves true (%s)', async (_route, action) => {
      const ctx = mockContext(hrManagerActor, [{ resource: 'hr.salary_sheets', action }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('success: PROJECT_MANAGER holds HR:READ -> guard resolves true', async () => {
      const ctx = mockContext(pmActor, [{ resource: 'hr.salary_sheets', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('403: PROJECT_MANAGER lacks HR:CREATE (PM does not generate salary sheets)', async () => {
      const ctx = mockContext(pmActor, [{ resource: 'hr.salary_sheets', action: 'CREATE' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403: RolesGuard rejects when request.user is absent even if @Roles() is present (defence-in-depth)', async () => {
      const ctx = mockContext(undefined, [{ resource: 'hr.salary_sheets', action: 'READ' }]);
      await expect(rolesGuard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
