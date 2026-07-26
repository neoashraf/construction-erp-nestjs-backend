/**
 * The punch-level read behind `GET /api/logs` (SUPPORTING_APIS_GUIDE §2).
 *
 * `/api/logs` is the DEVICE LOG view: every field in its contract (`id`, `deviceTimestamp`,
 * `occurredAt`, `receivedAt`, `punchCount`) is a property of an individual punch, not of a day. So it
 * reads `checkin_log` — the raw punches — rather than `attendance_record`, which the reports read.
 *
 * ⚠️ CONSEQUENCE: attendance captured WITHOUT a device (manual entry, CSV biometric import) has no
 * `checkin_log` row and therefore does not appear here. That is inherent to what this endpoint is; use
 * `/api/reports/range` for attendance truth. Documented on the controller too.
 */

/** One raw punch, as `/api/logs` reports it. */
export interface PunchRow {
  id: string;
  userId: string;
  deviceTimestamp: string;
  receivedAt: Date;
}

export const ATTENDANCE_LOG_READ_PORT = Symbol('ATTENDANCE_LOG_READ_PORT');

export interface AttendanceLogReadPort {
  /**
   * Every punch for the given employee codes in the window, ordered by (userId, deviceTimestamp) so the
   * caller can group by day and take first/last without re-sorting.
   */
  listPunches(
    companyId: string,
    employeeCodes: readonly string[],
    dateFrom: string,
    dateTo: string,
  ): Promise<PunchRow[]>;
}
