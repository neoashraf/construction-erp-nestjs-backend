/**
 * Persistence for device punch ingestion (SUPPORTING_APIS_GUIDE §5.4) plus the reconciliation that keeps
 * `attendance_record` the single source of truth for attendance.
 *
 * Two-step by design:
 *   1. `insertPunches` appends raw punches to `checkin_log` (idempotent — a replayed batch is a no-op).
 *   2. `reconcileDay` folds one employee-day's punches into the OFFICE `attendance_record` row that the
 *      reports and payroll already read: check_in = first punch, check_out = last punch.
 * Without step 2 a punch would never reach a report; without step 1 the individual punches would be lost.
 */

/** A punch ready to store — `deviceTimestamp` stays raw text. */
export interface PunchToStore {
  sourceType: string;
  userId: string;
  deviceTimestamp: string;
  status: string;
  occurredAt: Date | null;
  deviceSn: string | null;
}

/** Which company (and fallback project) a device's punches belong to. */
export interface DeviceMapping {
  companyId: string;
  defaultProjectId: string | null;
}

/** Why one employee-day could not be folded into `attendance_record`. */
export type ReconcileSkipReason =
  | 'UNKNOWN_EMPLOYEE_CODE'
  | 'NO_PROJECT'
  | 'NO_FINANCIAL_YEAR'
  | 'ALREADY_CONFIRMED';

export interface ReconcileOutcome {
  reconciled: number;
  skipped: Array<{ userId: string; attendanceDate: string; reason: ReconcileSkipReason }>;
}

export const PUNCH_INGESTION_REPOSITORY = Symbol('PUNCH_INGESTION_REPOSITORY');

export interface PunchIngestionRepository {
  /** Resolve the tenant from the device serial. Null when the serial is not registered. */
  findDeviceMapping(deviceSn: string | null): Promise<DeviceMapping | null>;

  /** Append raw punches; duplicates (same company + user + timestamp) are silently skipped. */
  insertPunches(companyId: string, punches: readonly PunchToStore[]): Promise<number>;

  /** Fold each touched employee-day's punches into its OFFICE `attendance_record` row. */
  reconcileDays(
    companyId: string,
    defaultProjectId: string | null,
    days: ReadonlyArray<{ userId: string; attendanceDate: string }>,
  ): Promise<ReconcileOutcome>;

  /** Newest ingested punch, for `GET /api/sync/status`. */
  findLatestPunch(
    companyId: string,
  ): Promise<{ deviceTimestamp: string; receivedAt: Date } | null>;

  /** Record the heartbeat on the device row so liveness survives a restart. */
  touchDeviceLastSeen(deviceSn: string, seenAt: Date): Promise<void>;
}
