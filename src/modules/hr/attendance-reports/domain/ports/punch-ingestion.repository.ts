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

  /**
   * Register a first-contact serial against an EXPLICITLY configured company
   * (`DEVICE_DEFAULT_COMPANY_ID`) and return its mapping.
   *
   * The company is never inferred from the data — guessing would attribute one tenant's
   * attendance to another. This exists so a device being commissioned does not silently
   * discard real punches while an admin gets around to registering it; the caller logs a
   * warning so the operator still assigns the right company/project.
   *
   * Returns null when the configured company does not exist, so a stale env var cannot
   * create orphaned device rows.
   */
  autoRegisterDevice(deviceSn: string, companyId: string): Promise<DeviceMapping | null>;

  /**
   * Default project from any registered device in the company, for a PULL sync — which has no
   * serial to resolve, since the server dialled the device rather than the reverse. Null when
   * no device carries one; reconciliation then falls back to each employee's own project.
   */
  findCompanyDefaultProject(companyId: string): Promise<string | null>;

  /**
   * Register a first-contact serial against an EXPLICITLY configured company
   * (`DEVICE_DEFAULT_COMPANY_ID`) and return its mapping.
   *
   * The company is never inferred from the data — guessing would attribute one tenant's
   * attendance to another. This exists so that a device being commissioned does not silently
   * discard real punches while an admin gets around to registering it; the caller logs a
   * warning so the operator still knows to assign the right company/project.
   *
   * Returns null when the configured company does not exist, so a stale env var cannot
   * create orphaned device rows.
   */
  autoRegisterDevice(deviceSn: string, companyId: string): Promise<DeviceMapping | null>;

  /**
   * Default project from any registered device in the company, for a PULL sync — which has no
   * serial to resolve, since the server dialled the device rather than the reverse. Null when
   * no device carries one; reconciliation then falls back to each employee's own project.
   */
  findCompanyDefaultProject(companyId: string): Promise<string | null>;

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

  /**
   * Distinct (employee code, day) pairs that have punches in the window — the work list for a manual
   * re-reconcile (`POST /api/sync`). Bounded by the caller's date range, never a full-table scan.
   */
  listPunchDays(
    companyId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<Array<{ userId: string; attendanceDate: string }>>;

  /** Record the heartbeat on the device row so liveness survives a restart. */
  touchDeviceLastSeen(deviceSn: string, seenAt: Date): Promise<void>;
}
