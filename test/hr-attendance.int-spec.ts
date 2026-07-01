/**
 * HR people-and-attendance integration — Testcontainers Postgres, real migrations + LED triggers + the
 * real PostingService/LED/NUM/PER. Proves the daily-labour accrual end-to-end and the module invariants:
 *   - AC1  : confirm posts a balanced DAILY_LABOUR_ACCRUAL entry (Σdr=Σcr=21,400 exact), Dr labour cost /
 *            Cr labour-payable, every line tagged project+cost_centre+purpose (no godown/party); gapless
 *            entry_no; accrual_entry_id linked; the deferred balance trigger passes.
 *   - AC5/13: a confirm into a CLOSED period rolls back — row UNCONFIRMED, no entry, NO number consumed.
 *   - AC6  : reverse writes a linked swapped-side entry; the original entry is byte-for-byte unchanged.
 *   - AC3  : a SUBCONTRACTOR capture creates NO journal_entry (GL-free tracking).
 *   - AC8  : a re-confirm is rejected (ALREADY_CONFIRMED); one accrual, one accrual_entry_id.
 *   - AC10 : reassignment APPENDS an employee_assignment row (append-only history).
 * CI runs the LED + HR migrations on a fresh DB first so the triggers + CHECKs + partial-uniques are
 * genuinely exercised.
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

import { InitialBaseline1700000000000 } from '../src/database/migrations/1700000000000-InitialBaseline';
import { CreateCompanyFinancialYear1700000100000 } from '../src/database/migrations/1700000100000-CreateCompanyFinancialYear';
import { CreateNumberingSeries1700000200000 } from '../src/database/migrations/1700000200000-CreateNumberingSeries';
import { CreateAccountingPeriod1700000300000 } from '../src/database/migrations/1700000300000-CreateAccountingPeriod';
import { CreateLedger1700000400000 } from '../src/database/migrations/1700000400000-CreateLedger';
import { CreateMasterDataDimensions1700000500000 } from '../src/database/migrations/1700000500000-CreateMasterDataDimensions';
import { CreateMasterDataAccountsPartiesItems1700000600000 } from '../src/database/migrations/1700000600000-CreateMasterDataAccountsPartiesItems';
import { CreateHrEmployeeAttendance1700001300000 } from '../src/database/migrations/1700001300000-CreateHrEmployeeAttendance';

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
import { TypeOrmLabourPayableRepository } from '../src/modules/hr/infrastructure/typeorm-labour-payable.repository';
import { HrAccountResolverAdapter } from '../src/modules/hr/infrastructure/hr-account-resolver.adapter';
import { HrProjectStatusAdapter } from '../src/modules/hr/infrastructure/hr-project-status.adapter';
import { PostingServiceAdapter } from '../src/modules/hr/infrastructure/posting-service.adapter';
import { CsvBiometricImportAdapter } from '../src/modules/hr/infrastructure/biometric-import.adapter';
import { AttendanceService } from '../src/modules/hr/application/attendance.service';
import { EmployeeService } from '../src/modules/hr/application/employee.service';
import { AlreadyConfirmedError } from '../src/modules/hr/domain/errors';

jest.setTimeout(180_000);

const CO = '00000000-0000-0000-0000-0000000000c0';
const FY1 = '00000000-0000-0000-0000-0000000000f1';
const PERIOD = '00000000-0000-0000-0000-0000000000e1';
const USER = '00000000-0000-0000-0000-0000000000a1';
const GROUP = '00000000-0000-0000-0000-0000000000b1';
const PROJECT = '00000000-0000-0000-0000-00000000d001';
const CC_SLAB = '00000000-0000-0000-0000-00000000d002';
const CC_BRICK = '00000000-0000-0000-0000-00000000d005';
const PURPOSE = '00000000-0000-0000-0000-00000000d003';
const PARTY = '00000000-0000-0000-0000-00000000d004';
const ACC_LABOUR = '00000000-0000-0000-0000-00000000a511'; // 5110
const ACC_PAYABLE = '00000000-0000-0000-0000-00000000a231'; // 2310

const actor: Actor = {
  userId: USER,
  companyId: CO,
  financialYearId: FY1,
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

describe('HR attendance & daily-labour accrual (real Postgres + real PostingService)', () => {
  let container: StartedPostgreSqlContainer;
  let ds: DataSource;
  let attendance: AttendanceService;
  let employees: EmployeeService;

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
      ],
      migrations: [
        InitialBaseline1700000000000,
        CreateCompanyFinancialYear1700000100000,
        CreateNumberingSeries1700000200000,
        CreateAccountingPeriod1700000300000,
        CreateLedger1700000400000,
        CreateMasterDataDimensions1700000500000,
        CreateMasterDataAccountsPartiesItems1700000600000,
        CreateHrEmployeeAttendance1700001300000,
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
    await acc(ACC_LABOUR, '5110', 'Labour Expense', 'EXPENSE');
    await acc(ACC_PAYABLE, '2310', 'Daily-Labour Payable', 'LIABILITY');

    await ds.query(
      `INSERT INTO party (id, company_id, name, is_customer, is_supplier, phone) VALUES ($1,$2,'Subcontractor A',false,true,'+8801700000000')`,
      [PARTY, CO],
    );
    await ds.query(
      `INSERT INTO project (id, company_id, project_code, name, customer_id, project_manager_id, start_date, expected_end_date, status) VALUES ($1,$2,'P-01','Site A',$3,$4,'2025-07-01','2026-06-30','ACTIVE')`,
      [PROJECT, CO, PARTY, USER],
    );
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-Slab','Slab')`, [CC_SLAB, CO]);
    await ds.query(`INSERT INTO cost_centre (id, company_id, code, name) VALUES ($1,$2,'CC-Brick','Brickwork')`, [CC_BRICK, CO]);
    await ds.query(`INSERT INTO purpose (id, company_id, project_id, name) VALUES ($1,$2,$3,'Day 20 labour')`, [
      PURPOSE,
      CO,
      PROJECT,
    ]);

    const uow = new TypeOrmUnitOfWork(ds);
    const ids = new UuidIdGenerator();
    const clock = { now: () => new Date('2026-06-20T10:00:00Z') };
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
    attendance = new AttendanceService(
      new TypeOrmAttendanceRepository(ds),
      new TypeOrmLabourPayableRepository(ds),
      new TypeOrmEmployeeRepository(ds),
      new HrAccountResolverAdapter(ds),
      new HrProjectStatusAdapter(ds),
      new PostingServiceAdapter(posting),
      new CsvBiometricImportAdapter(),
      audit as never,
      uow,
      ids,
    );
    employees = new EmployeeService(new TypeOrmEmployeeRepository(ds), audit as never, uow, ids);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (container) await container.stop();
  });

  afterEach(async () => {
    await ds.query(
      'TRUNCATE journal_line, journal_entry, labour_payable, attendance_record, employee_assignment, employee, numbering_series RESTART IDENTITY CASCADE',
    );
  });

  async function captureDailyLabour(costCentreId: string, headCount: number, dailyRate: string): Promise<string> {
    const { ids } = await attendance.capture(
      'DAILY_LABOUR',
      [
        {
          attendanceDate: '2026-06-20',
          projectId: PROJECT,
          costCentreId,
          purposeId: PURPOSE,
          headCount,
          dailyRate,
        } as never,
      ],
      actor,
    );
    return ids[0];
  }

  it('AC1/AC13: confirm posts a balanced DAILY_LABOUR_ACCRUAL, tagged dims, gapless number, payable linked', async () => {
    const slab = await captureDailyLabour(CC_SLAB, 20, '650'); // 13,000
    const brick = await captureDailyLabour(CC_BRICK, 12, '700'); // 8,400

    const r1 = await attendance.confirmDailyLabour(slab, undefined, actor);
    const r2 = await attendance.confirmDailyLabour(brick, undefined, actor);

    // each confirm posts one entry
    const [e1] = await ds.query(`SELECT entry_no, voucher_type FROM journal_entry WHERE id=$1`, [r1.accrualEntryId]);
    expect(e1.voucher_type).toBe('DAILY_LABOUR_ACCRUAL');
    expect(e1.entry_no).toBe(r1.entryNo);
    expect(r1.entryNo).toMatch(/DLA\//);
    expect(r1.accruedAmount).toBe('13000.0000');
    expect(r2.accruedAmount).toBe('8400.0000');

    // slab entry balances Dr labour / Cr payable, dims tagged, no godown/party
    const [sum1] = await ds.query(
      `SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`,
      [r1.accrualEntryId],
    );
    expect(sum1.dr).toBe(sum1.cr);
    expect(sum1.dr).toBe('13000.0000');

    const drLine = await ds.query(
      `SELECT account_id, project_id, cost_centre_id, purpose_id, godown_id, party_id, debit::text d FROM journal_line WHERE journal_entry_id=$1 AND debit > 0`,
      [r1.accrualEntryId],
    );
    expect(drLine).toHaveLength(1);
    expect(drLine[0]).toMatchObject({
      account_id: ACC_LABOUR,
      project_id: PROJECT,
      cost_centre_id: CC_SLAB,
      purpose_id: PURPOSE,
      godown_id: null,
      party_id: null,
    });
    const crLine = await ds.query(
      `SELECT account_id, godown_id, party_id, credit::text c FROM journal_line WHERE journal_entry_id=$1 AND credit > 0`,
      [r1.accrualEntryId],
    );
    expect(crLine[0]).toMatchObject({ account_id: ACC_PAYABLE, godown_id: null, party_id: null });

    // attendance CONFIRMED with the entry linked; payable OUTSTANDING at the accrued amount
    const [a] = await ds.query(`SELECT is_confirmed, accrual_entry_id FROM attendance_record WHERE id=$1`, [slab]);
    expect(a.is_confirmed).toBe(true);
    expect(a.accrual_entry_id).toBe(r1.accrualEntryId);
    const [lp] = await ds.query(`SELECT accrued_amount::text a, settled_amount::text s, status FROM labour_payable WHERE accrual_entry_id=$1`, [
      r1.accrualEntryId,
    ]);
    expect(lp.a).toBe('13000.0000');
    expect(lp.s).toBe('0.0000');
    expect(lp.status).toBe('OUTSTANDING');
  });

  it('AC5/AC13: confirm into a CLOSED period rolls back — row UNCONFIRMED, no entry, no number', async () => {
    const slab = await captureDailyLabour(CC_SLAB, 20, '650');
    await ds.query(`UPDATE accounting_period SET status='CLOSED' WHERE id=$1`, [PERIOD]);
    try {
      await expect(attendance.confirmDailyLabour(slab, undefined, actor)).rejects.toMatchObject({
        code: 'PERIOD_CLOSED',
      });
      const [{ n: entries }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
      expect(entries).toBe(0);
      const [{ n: series }] = await ds.query(`SELECT count(*)::int n FROM numbering_series`);
      expect(series).toBe(0);
      const [{ n: pay }] = await ds.query(`SELECT count(*)::int n FROM labour_payable`);
      expect(pay).toBe(0);
      const [a] = await ds.query(`SELECT is_confirmed, accrual_entry_id FROM attendance_record WHERE id=$1`, [slab]);
      expect(a.is_confirmed).toBe(false);
      expect(a.accrual_entry_id).toBeNull();
    } finally {
      await ds.query(`UPDATE accounting_period SET status='OPEN' WHERE id=$1`, [PERIOD]);
    }
  });

  it('AC6: reverse writes a linked swapped-side entry; the original entry is byte-for-byte unchanged', async () => {
    const slab = await captureDailyLabour(CC_SLAB, 20, '650');
    const confirmed = await attendance.confirmDailyLabour(slab, undefined, actor);
    const before = await ds.query(
      `SELECT id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [confirmed.accrualEntryId],
    );

    const rev = await attendance.reverseAccrual(slab, 'headcount corrected', actor);

    const after = await ds.query(
      `SELECT id, debit::text d, credit::text c FROM journal_line WHERE journal_entry_id=$1 ORDER BY line_no`,
      [confirmed.accrualEntryId],
    );
    expect(after).toEqual(before);
    const [reversal] = await ds.query(`SELECT id, is_reversal, reversal_of FROM journal_entry WHERE reversal_of=$1`, [
      confirmed.accrualEntryId,
    ]);
    expect(reversal.is_reversal).toBe(true);
    expect(rev.reversalEntryId).toBe(reversal.id);
    expect(rev.originalEntryId).toBe(confirmed.accrualEntryId);
    // reversal balances (swapped) at the same total
    const [sum] = await ds.query(`SELECT SUM(debit)::text dr, SUM(credit)::text cr FROM journal_line WHERE journal_entry_id=$1`, [
      reversal.id,
    ]);
    expect(sum.dr).toBe(sum.cr);
    expect(sum.dr).toBe('13000.0000');
  });

  it('AC3: a SUBCONTRACTOR capture creates NO journal_entry (GL-free tracking)', async () => {
    const { ids } = await attendance.capture(
      'SUBCONTRACTOR',
      [
        {
          partyId: PARTY,
          attendanceDate: '2026-06-20',
          projectId: PROJECT,
          costCentreId: CC_SLAB,
          headCount: 8,
        } as never,
      ],
      actor,
    );
    expect(ids).toHaveLength(1);
    const [{ n }] = await ds.query(`SELECT count(*)::int n FROM journal_entry`);
    expect(n).toBe(0);
    const [row] = await ds.query(`SELECT mode, is_confirmed, accrual_entry_id FROM attendance_record WHERE id=$1`, [ids[0]]);
    expect(row.mode).toBe('SUBCONTRACTOR');
    expect(row.is_confirmed).toBe(false);
    expect(row.accrual_entry_id).toBeNull();
  });

  it('AC8: a re-confirm is rejected; one accrual, one accrual_entry_id', async () => {
    const slab = await captureDailyLabour(CC_SLAB, 20, '650');
    await attendance.confirmDailyLabour(slab, undefined, actor);
    await expect(attendance.confirmDailyLabour(slab, undefined, actor)).rejects.toBeInstanceOf(
      AlreadyConfirmedError,
    );
    const [{ n }] = await ds.query(`SELECT count(*)::int n FROM journal_entry WHERE voucher_type='DAILY_LABOUR_ACCRUAL'`);
    expect(n).toBe(1);
  });

  it('AC10: reassignment APPENDS an employee_assignment row (append-only history)', async () => {
    const { id } = await employees.create(
      {
        employeeCode: 'EMP-014',
        name: 'মোঃ রফিকুল ইসলাম',
        designation: 'Site Accountant',
        defaultProjectId: PROJECT,
        workBase: 'SITE',
        wageType: 'MONTHLY',
        wageAmount: '45000',
        joiningDate: '2025-07-01',
      },
      actor,
    );
    // initial assignment seeded from the default project
    let rows = await ds.query(`SELECT project_id, effective_date FROM employee_assignment WHERE employee_id=$1 ORDER BY effective_date`, [id]);
    expect(rows).toHaveLength(1);

    await employees.reassign(id, { projectId: PROJECT, effectiveDate: '2025-09-01', note: 'phase 2' }, 1, actor);

    rows = await ds.query(`SELECT project_id, effective_date FROM employee_assignment WHERE employee_id=$1 ORDER BY effective_date`, [id]);
    expect(rows).toHaveLength(2); // prior row retained; a new one appended
    const [emp] = await ds.query(`SELECT default_project_id, status FROM employee WHERE id=$1`, [id]);
    expect(emp.default_project_id).toBe(PROJECT);
    expect(emp.status).toBe('ACTIVE');
  });
});
