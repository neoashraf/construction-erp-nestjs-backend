/**
 * AttendanceReportService unit tests (no DB, no Nest) — drives the service through a fake read port so
 * the whole REPORTS_MODULE_GUIDE contract is asserted: the gap-free calendar, the counting model where
 * `lateCount` is a SUBSET of `presentCount` (§3.5), totals over the whole filtered set while `data` is
 * paged (§3.6), the window rules (§3.1), and the three CSV layouts (§5.3–§5.5).
 */
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { AttendanceReportService } from '../../../src/modules/hr/attendance-reports/application/attendance-report.service';
import { EmployeeIdentity } from '../../../src/modules/hr/attendance-reports/domain/attendance-report.model';
import {
  AttendanceReportReadPort,
  DailyPunchRow,
  EmployeeFilter,
  UnreconciledDayRow,
} from '../../../src/modules/hr/attendance-reports/domain/ports/attendance-report.read.port';
import {
  GovernmentHoliday,
  LateThreshold,
} from '../../../src/modules/hr/attendance-reports/domain/attendance-rules';

const ACTOR = { companyId: 'co1', userId: 'u1' } as Actor;

interface FakeData {
  employees: EmployeeIdentity[];
  punches: DailyPunchRow[];
  threshold?: LateThreshold;
  weeklyHolidays?: number[];
  governmentHolidays?: GovernmentHoliday[];
  /** Employee-days with punches but no reconciled row — the FR-HR-008a guard's input. */
  unreconciled?: UnreconciledDayRow[];
}

class FakeReadPort implements AttendanceReportReadPort {
  constructor(private readonly data: FakeData) {}

  loadEmployees(_companyId: string, filter: EmployeeFilter): Promise<EmployeeIdentity[]> {
    let rows = this.data.employees;
    if (filter.userId) rows = rows.filter((e) => e.userId === filter.userId);
    if (filter.name) {
      const needle = filter.name.toLowerCase();
      rows = rows.filter((e) => e.name.toLowerCase().includes(needle));
    }
    return Promise.resolve(rows);
  }

  loadDailyPunches(
    _companyId: string,
    employeeIds: readonly string[],
    startDateText: string,
    endDateText: string,
  ): Promise<DailyPunchRow[]> {
    const ids = new Set(employeeIds);
    return Promise.resolve(
      this.data.punches.filter(
        (p) =>
          ids.has(p.employeeId) &&
          p.attendanceDate >= startDateText &&
          p.attendanceDate <= endDateText,
      ),
    );
  }

  loadUnreconciledDays(): Promise<UnreconciledDayRow[]> {
    return Promise.resolve(this.data.unreconciled ?? []);
  }

  getAttendanceSetting(): Promise<LateThreshold> {
    return Promise.resolve(this.data.threshold ?? { lateAfterHour: 9, lateAfterMinute: 30 });
  }

  getWeeklyHolidayWeekdays(): Promise<number[]> {
    return Promise.resolve(this.data.weeklyHolidays ?? []);
  }

  getGovernmentHolidayDates(
    _companyId: string,
    dateList: readonly string[],
  ): Promise<Map<string, GovernmentHoliday>> {
    const wanted = new Set(dateList);
    return Promise.resolve(
      new Map(
        (this.data.governmentHolidays ?? [])
          .filter((h) => wanted.has(h.date))
          .map((h) => [h.date, h]),
      ),
    );
  }
}

function serviceWith(data: FakeData): AttendanceReportService {
  return new AttendanceReportService(new FakeReadPort(data));
}

const KARIM: EmployeeIdentity = {
  id: 'e1',
  userId: '1042',
  name: 'Karim Rahman',
  designation: 'Operator',
};
const SALMA: EmployeeIdentity = {
  id: 'e2',
  userId: '1043',
  name: 'Salma Akter',
  designation: null,
};

/**
 * A worked day. `dayStatus` defaults to PRESENT, which is what reconciliation writes on create, so
 * Present-vs-Late still comes from the check-in against the threshold.
 */
function punch(
  employeeId: string,
  attendanceDate: string,
  checkIn: string | null,
  checkOut: string | null = null,
  dayStatus: string | null = 'PRESENT',
): DailyPunchRow {
  return {
    employeeId,
    attendanceDate,
    checkInAt: checkIn ? `${attendanceDate} ${checkIn}` : null,
    checkOutAt: checkOut ? `${attendanceDate} ${checkOut}` : null,
    punchCount: (checkIn ? 1 : 0) + (checkOut ? 1 : 0),
    dayStatus,
  };
}

/** A day carrying a STATUS and no times — the case a punch-sourced report could not represent. */
function timelessDay(
  employeeId: string,
  attendanceDate: string,
  dayStatus: string,
): DailyPunchRow {
  return {
    employeeId,
    attendanceDate,
    checkInAt: null,
    checkOutAt: null,
    punchCount: 0,
    dayStatus,
  };
}

// ── daily ────────────────────────────────────────────────────────────────────────────────────────

describe('getDailyReport', () => {
  it('shapes one row per employee with display-ready times', async () => {
    const service = serviceWith({
      employees: [KARIM, SALMA],
      punches: [punch('e1', '2026-07-01', '09:12:04', '18:03:51')],
    });

    const report = await service.getDailyReport({ date: '2026-07-01' }, ACTOR);

    expect(report.date).toBe('2026-07-01');
    expect(report.isHoliday).toBe(false);
    expect(report.holiday).toBeNull();
    expect(report.lateAfter).toBe('09:30');
    expect(report.data).toHaveLength(2);
    expect(report.data[0]).toEqual({
      id: 'e1',
      userId: '1042',
      name: 'Karim Rahman',
      designation: 'Operator',
      attendanceDate: '2026-07-01',
      status: 'Present',
      checkInAt: '2026-07-01 09:12:04',
      checkOutAt: '2026-07-01 18:03:51',
      checkInTime: '9:12:04 AM',
      checkOutTime: '6:03:51 PM',
      punchCount: 2,
    });
    // Salma has no punch → absent, blank display times.
    expect(report.data[1]?.status).toBe('Absent');
    expect(report.data[1]?.checkInTime).toBe('');
  });

  it('reports totals over both employees', async () => {
    const service = serviceWith({
      employees: [KARIM, SALMA],
      punches: [punch('e1', '2026-07-01', '09:45:00')],
    });

    const report = await service.getDailyReport({ date: '2026-07-01' }, ACTOR);

    expect(report.totals).toEqual({
      totalEmployees: 2,
      workingDays: 1,
      onTimeCount: 0,
      lateCount: 1,
      presentCount: 1,
      absentCount: 1,
      holidayCount: 0,
      attendancePercentage: 50,
      paidLeaveCount: 0,
      unpaidLeaveCount: 0,
    });
  });

  it('flags the day and every row as a holiday when the date is a government holiday', async () => {
    const service = serviceWith({
      employees: [KARIM],
      punches: [punch('e1', '2026-07-01', '09:12:04')],
      governmentHolidays: [{ date: '2026-07-01', name: 'Eid ul-Fitr', localName: null }],
    });

    const report = await service.getDailyReport({ date: '2026-07-01' }, ACTOR);

    expect(report.isHoliday).toBe(true);
    expect(report.holiday).toEqual({ name: 'Eid ul-Fitr', type: 'government' });
    expect(report.data[0]?.status).toBe('Holiday');
    // A holiday zeroes the working days, so the percentage guard returns 0 rather than dividing by 0.
    expect(report.totals.workingDays).toBe(0);
    expect(report.totals.attendancePercentage).toBe(0);
  });
});

// ── range ────────────────────────────────────────────────────────────────────────────────────────

describe('getRangeReport', () => {
  it('produces a gap-free calendar and the subset counting model', async () => {
    const service = serviceWith({
      employees: [KARIM],
      // Mon 2026-07-06 on time, Tue 2026-07-07 late, Wed 2026-07-08 no punch.
      punches: [
        punch('e1', '2026-07-06', '09:12:04', '18:00:00'),
        punch('e1', '2026-07-07', '09:41:10'),
      ],
    });

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-06', dateTo: '2026-07-08' },
      ACTOR,
    );

    expect(report.label).toBe('6 Jul 2026 - 8 Jul 2026');
    expect(report.totalDays).toBe(3);
    expect(report.totalWorkingDays).toBe(3);

    const employee = report.data[0];
    expect(employee?.records).toHaveLength(3);
    expect(employee?.records.map((r) => r.status)).toEqual(['Present', 'Late', 'Absent']);
    // presentCount = onTime + late — NOT a sibling bucket (§3.5).
    expect(employee?.onTimeCount).toBe(1);
    expect(employee?.lateCount).toBe(1);
    expect(employee?.presentCount).toBe(2);
    expect(employee?.absentCount).toBe(1);
    expect(employee?.attendancePercentage).toBe(66.7);
  });

  it('emits Working 22 / Present 22 / Late 2 / Absent 0 without treating late as a separate bucket', async () => {
    const dates: DailyPunchRow[] = [];
    for (let day = 1; day <= 22; day += 1) {
      const date = `2026-06-${String(day).padStart(2, '0')}`;
      dates.push(punch('e1', date, day <= 2 ? '09:45:00' : '09:00:00'));
    }
    const service = serviceWith({ employees: [KARIM], punches: dates });

    const report = await service.getRangeReport(
      { dateFrom: '2026-06-01', dateTo: '2026-06-22' },
      ACTOR,
    );

    const employee = report.data[0];
    expect(employee?.workingDays).toBe(22);
    expect(employee?.presentCount).toBe(22);
    expect(employee?.lateCount).toBe(2);
    expect(employee?.absentCount).toBe(0);
    expect(employee?.attendancePercentage).toBe(100);
  });

  it('names a weekly holiday and marks it on the record', async () => {
    // 2026-07-03 is a Friday.
    const service = serviceWith({
      employees: [KARIM],
      punches: [],
      weeklyHolidays: [5],
    });

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-01', dateTo: '2026-07-03' },
      ACTOR,
    );

    const friday = report.data[0]?.records[2];
    expect(friday?.attendanceDate).toBe('2026-07-03');
    expect(friday?.status).toBe('Holiday');
    expect(friday?.holidayName).toBe('Weekly Holiday');
    expect(friday?.holidayType).toBe('weekly');
    expect(report.totalWorkingDays).toBe(2);
  });
});

// ── window + pagination ──────────────────────────────────────────────────────────────────────────

describe('window resolution (§3.1)', () => {
  const service = serviceWith({ employees: [KARIM], punches: [] });

  it('rejects one end of the range without the other', async () => {
    await expect(service.getRangeReport({ dateFrom: '2026-07-01' }, ACTOR)).rejects.toThrow(
      'dateFrom and dateTo must be supplied together',
    );
  });

  it('rejects an inverted range', async () => {
    await expect(
      service.getRangeReport({ dateFrom: '2026-07-10', dateTo: '2026-07-01' }, ACTOR),
    ).rejects.toThrow('dateFrom must not be after dateTo');
  });

  it('rejects a range longer than 366 days', async () => {
    await expect(
      service.getRangeReport({ dateFrom: '2025-01-01', dateTo: '2026-07-01' }, ACTOR),
    ).rejects.toThrow(/Date range must not exceed 366 days \(requested \d+\)/);
  });

  it('defaults to the current month so far when no dates are given', async () => {
    const report = await service.getRangeReport({}, ACTOR);
    const today = new Date();
    const firstOfMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;

    expect(report.dateFrom).toBe(firstOfMonth);
    expect(report.dateTo >= report.dateFrom).toBe(true);
  });
});

describe('pagination vs totals (§3.6)', () => {
  const employees: EmployeeIdentity[] = Array.from({ length: 5 }, (_, i) => ({
    id: `e${i + 1}`,
    userId: String(1000 + i),
    name: `Employee ${i + 1}`,
    designation: null,
  }));

  it('slices data but keeps totals over the whole filtered set', async () => {
    const service = serviceWith({
      employees,
      punches: employees.map((e) => punch(e.id, '2026-07-01', '09:00:00')),
    });

    const report = await service.getSummaryReport(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01', page: '2', limit: '2' },
      ACTOR,
    );

    expect(report.data).toHaveLength(2);
    expect(report.data[0]?.userId).toBe('1002');
    expect(report.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    // Totals still describe all five, not the two on this page.
    expect(report.totals.totalEmployees).toBe(5);
    expect(report.totals.presentCount).toBe(5);
  });

  it('caps limit at 100 and floors page at 1', async () => {
    const service = serviceWith({ employees, punches: [] });

    const report = await service.getSummaryReport(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01', page: '0', limit: '5000' },
      ACTOR,
    );

    expect(report.pagination.page).toBe(1);
    expect(report.pagination.limit).toBe(100);
  });

  it('applies the userId and name filters', async () => {
    const service = serviceWith({ employees: [KARIM, SALMA], punches: [] });

    const byId = await service.getSummaryReport(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01', userId: '1043' },
      ACTOR,
    );
    expect(byId.totals.totalEmployees).toBe(1);
    expect(byId.data[0]?.name).toBe('Salma Akter');

    const byName = await service.getSummaryReport(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01', name: 'karim' },
      ACTOR,
    );
    expect(byName.data[0]?.userId).toBe('1042');
  });
});

// ── exports ──────────────────────────────────────────────────────────────────────────────────────

describe('CSV exports', () => {
  it('lays out the daily export with the Excel text-literal date/time cells and a totals row', async () => {
    const service = serviceWith({
      employees: [KARIM],
      punches: [punch('e1', '2026-07-01', '09:12:04', '18:03:51')],
    });

    const csv = await service.exportDailyReportCsv({ date: '2026-07-01' }, ACTOR);
    const lines = csv.split('\r\n');

    expect(lines[0]).toBe('Daily Attendance 2026-07-01');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('User ID,Name,Designation,Date,Status,Checkin Time,Checkout Time');
    // The Excel text-literal `="…"` contains a quote, so `escapeCsvValue` wraps it and doubles the inner
    // quotes — these are the FILE BYTES. Excel unescapes back to `="2026-07-01"` and shows literal text,
    // which is what the guide's §5.3 layout sketch depicts. Same behaviour as the Express `toCsv`.
    expect(lines[3]).toBe(
      '1042,Karim Rahman,Operator,"=""2026-07-01""",Present,"=""9:12:04 AM""","=""6:03:51 PM"""',
    );
    expect(lines[5]).toBe(
      'Totals,Present: 1,Late: 0,Absent: 0,Holiday: 0,Paid leave: 0,Unpaid leave: 0',
    );
  });

  it('ignores pagination on export so every matching employee is in the file', async () => {
    const employees: EmployeeIdentity[] = Array.from({ length: 5 }, (_, i) => ({
      id: `e${i + 1}`,
      userId: String(1000 + i),
      name: `Employee ${i + 1}`,
      designation: null,
    }));
    const service = serviceWith({ employees, punches: [] });

    const csv = await service.exportDailyReportCsv(
      { date: '2026-07-01', page: '2', limit: '2' },
      ACTOR,
    );

    for (const employee of employees) {
      expect(csv).toContain(employee.userId);
    }
  });

  it('writes identity columns only on an employee first row in the range export', async () => {
    const service = serviceWith({
      employees: [KARIM],
      punches: [punch('e1', '2026-07-01', '09:12:04')],
    });

    const csv = await service.exportRangeReportCsv(
      { dateFrom: '2026-07-01', dateTo: '2026-07-02' },
      ACTOR,
    );
    const lines = csv.split('\r\n');

    expect(lines[0]).toBe('Attendance Details 1 Jul 2026 - 2 Jul 2026');
    expect(lines[2]).toBe(
      'User ID,Name,Designation,Date,Day,Status,Checkin Time,Checkout Time,Holiday',
    );
    expect(lines[3]).toBe(''); // blank row separating the employee group
    expect(lines[4]).toBe(
      '1042,Karim Rahman,Operator,"=""2026-07-01""",Wednesday,Present,"=""9:12:04 AM""",,',
    );
    expect(lines[5]).toBe(',,,"=""2026-07-02""",Thursday,Absent,,,');
    expect(lines[6]).toBe(
      ',Totals,,Working: 2,,Present: 1,Late: 0,Absent: 1,Holidays: 0,Paid leave: 0,Unpaid leave: 0',
    );
  });

  it('writes one row per employee plus a grand-total row in the summary export', async () => {
    const service = serviceWith({
      employees: [KARIM, SALMA],
      punches: [punch('e1', '2026-07-01', '09:00:00')],
    });

    const csv = await service.exportSummaryReportCsv(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01' },
      ACTOR,
    );
    const lines = csv.split('\r\n');

    expect(lines[0]).toBe('Attendance Summary 1 Jul 2026');
    expect(lines[2]).toBe(
      'User ID,Name,Designation,Working,Present,On Time,Late,Absent,Paid Leave,Unpaid Leave,Holidays,Attendance %',
    );
    expect(lines[3]).toBe('1042,Karim Rahman,Operator,1,1,1,0,0,0,0,0,100');
    expect(lines[4]).toBe('1043,Salma Akter,,1,0,0,0,1,0,0,0,0');
    expect(lines[6]).toBe(',Totals (2 employees),,1,1,1,0,1,0,0,0,50');
  });

  it('pluralises the summary totals label for a single employee', async () => {
    const service = serviceWith({ employees: [KARIM], punches: [] });

    const csv = await service.exportSummaryReportCsv(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01' },
      ACTOR,
    );

    expect(csv).toContain('Totals (1 employee)');
  });
});

// ── attendance truth: a day can carry a STATUS with no times (FR-HR-004, FR-HR-013a) ─────────────

describe('timeless day statuses', () => {
  it('renders a PAID_LEAVE day as Paid leave and keeps it OUT of absentCount', async () => {
    // The defect this closes: payroll PAYS this day while the report — the document HR reconciles
    // a payslip against — called it an absence, because a leave day has no punches.
    const service = serviceWith({
      employees: [KARIM],
      punches: [timelessDay('e1', '2026-07-01', 'PAID_LEAVE')],
    });

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01' },
      ACTOR,
    );
    const row = report.data[0];

    expect(row?.records[0]?.status).toBe('Paid leave');
    expect(row?.records[0]?.checkInAt).toBeNull();
    expect(row?.absentCount).toBe(0);
    expect(row?.paidLeaveCount).toBe(1);
    expect(report.totals.absentCount).toBe(0);
  });

  it('renders an UNPAID_LEAVE day as Unpaid leave, also outside absentCount', async () => {
    const service = serviceWith({
      employees: [KARIM],
      punches: [timelessDay('e1', '2026-07-01', 'UNPAID_LEAVE')],
    });

    const row = (
      await service.getRangeReport({ dateFrom: '2026-07-01', dateTo: '2026-07-01' }, ACTOR)
    ).data[0];

    expect(row?.records[0]?.status).toBe('Unpaid leave');
    expect(row?.unpaidLeaveCount).toBe(1);
    expect(row?.absentCount).toBe(0);
  });

  it('renders an explicitly-marked ABSENT day exactly like a day with no record', async () => {
    // Both mean the same thing to a reader and to payroll, so they must not read differently.
    const service = serviceWith({
      employees: [KARIM],
      punches: [timelessDay('e1', '2026-07-01', 'ABSENT')],
    });

    const row = (
      await service.getRangeReport({ dateFrom: '2026-07-01', dateTo: '2026-07-01' }, ACTOR)
    ).data[0];

    expect(row?.records[0]?.status).toBe('Absent');
    expect(row?.absentCount).toBe(1);
  });

  it('still DERIVES Present vs Late from the check-in, never from the stored PRESENT status', async () => {
    // The stored status cannot express lateness; only the threshold comparison can (FR-HR-008c).
    const service = serviceWith({
      employees: [KARIM],
      punches: [punch('e1', '2026-07-01', '09:41:00', '18:00:00', 'PRESENT')],
    });

    const row = (
      await service.getRangeReport({ dateFrom: '2026-07-01', dateTo: '2026-07-01' }, ACTOR)
    ).data[0];

    expect(row?.records[0]?.status).toBe('Late');
    expect(row?.lateCount).toBe(1);
    expect(row?.presentCount).toBe(1); // late is a SUBSET of present (§3.5)
  });

  it('keeps 09:30:59 on time — the threshold minute must fully elapse', async () => {
    const service = serviceWith({
      employees: [KARIM],
      punches: [punch('e1', '2026-07-01', '09:30:59')],
    });

    const row = (
      await service.getRangeReport({ dateFrom: '2026-07-01', dateTo: '2026-07-01' }, ACTOR)
    ).data[0];

    expect(row?.records[0]?.status).toBe('Present');
    expect(row?.lateCount).toBe(0);
  });
});

// ── the skipped-day guard (FR-HR-008a) ───────────────────────────────────────────────────────────

describe('unreconciled-day guard', () => {
  it('reports a healthy window as zero rather than omitting the field', async () => {
    // Always present, so a client never has to tell "no problems" apart from "this version of the
    // API does not tell me".
    const service = serviceWith({
      employees: [KARIM],
      punches: [punch('e1', '2026-07-01', '09:00:00')],
    });

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01' },
      ACTOR,
    );

    expect(report.unreconciled).toEqual({ days: 0, reasons: {}, sample: [] });
  });

  it('says so when the window contains employee-days reconciliation could not place', async () => {
    // THE 27/07 REGRESSION, pinned: punches exist, nothing reconciled. Before the guard the report
    // rendered everyone Absent and looked like a complete, healthy report.
    const service = serviceWith({
      employees: [KARIM],
      punches: [],
      unreconciled: [
        { userId: '1042', attendanceDate: '2026-07-01', reason: 'NO_PROJECT' },
        { userId: '1043', attendanceDate: '2026-07-01', reason: 'NO_PROJECT' },
        { userId: '9999', attendanceDate: '2026-07-01', reason: 'UNKNOWN_EMPLOYEE_CODE' },
      ],
    });

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01' },
      ACTOR,
    );

    expect(report.unreconciled.days).toBe(3);
    expect(report.unreconciled.reasons).toEqual({ NO_PROJECT: 2, UNKNOWN_EMPLOYEE_CODE: 1 });
    expect(report.unreconciled.sample).toHaveLength(3);
    // The days themselves still read Absent — the guard is what tells the reader not to trust that.
    expect(report.data[0]?.absentCount).toBe(1);
  });

  it('carries the guard on daily and summary too, not just range', async () => {
    const unreconciled: UnreconciledDayRow[] = [
      { userId: '1042', attendanceDate: '2026-07-01', reason: 'NO_FINANCIAL_YEAR' },
    ];
    const service = serviceWith({ employees: [KARIM], punches: [], unreconciled });

    const daily = await service.getDailyReport({ date: '2026-07-01' }, ACTOR);
    const summary = await service.getSummaryReport(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01' },
      ACTOR,
    );

    expect(daily.unreconciled.reasons).toEqual({ NO_FINANCIAL_YEAR: 1 });
    expect(summary.unreconciled.reasons).toEqual({ NO_FINANCIAL_YEAR: 1 });
  });

  it('bounds the sample at 20 while still reporting the true total', async () => {
    const unreconciled: UnreconciledDayRow[] = Array.from({ length: 25 }, (_, i) => ({
      userId: String(1000 + i),
      attendanceDate: '2026-07-01',
      reason: 'NO_PROJECT' as const,
    }));
    const service = serviceWith({ employees: [KARIM], punches: [], unreconciled });

    const report = await service.getRangeReport(
      { dateFrom: '2026-07-01', dateTo: '2026-07-01' },
      ACTOR,
    );

    expect(report.unreconciled.days).toBe(25);
    expect(report.unreconciled.sample).toHaveLength(20);
  });
});
