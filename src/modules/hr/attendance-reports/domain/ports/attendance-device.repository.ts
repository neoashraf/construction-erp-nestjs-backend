/**
 * AttendanceDeviceRepository — CRUD over `attendance_device`, the serial→company registry.
 *
 * WHY THIS EXISTS: `attendance_device` was previously written only by auto-registration
 * (DEVICE_DEFAULT_COMPANY_ID) or by hand in SQL. In a multi-company deployment that is a
 * hidden operational step — commissioning a new client's device meant a developer opening
 * psql, and an unregistered serial fails SILENTLY (the push endpoint must answer the device
 * `OK` regardless, so punches are dropped with no user-visible error). This port is what
 * lets an admin do it from the UI instead.
 *
 * Read paths for INGESTION live in `punch-ingestion.repository` — this port is management
 * only, and never resolves a punch.
 */

export interface AttendanceDeviceDto {
  id: string;
  deviceSn: string;
  label: string | null;
  defaultProjectId: string | null;
  /** Resolved for display so the list needs no second lookup. */
  defaultProjectName: string | null;
  isActive: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export interface CreateAttendanceDeviceInput {
  deviceSn: string;
  label: string | null;
  defaultProjectId: string | null;
}

export interface UpdateAttendanceDeviceInput {
  label?: string | null;
  defaultProjectId?: string | null;
  isActive?: boolean;
}

export interface AttendanceDeviceRepository {
  list(companyId: string): Promise<AttendanceDeviceDto[]>;
  findById(companyId: string, id: string): Promise<AttendanceDeviceDto | null>;
  /**
   * Serial lookup is deliberately NOT company-scoped: `device_sn` is globally UNIQUE
   * (`uq_attendance_device_sn`), so a serial already claimed by ANOTHER company must be
   * reported as a conflict rather than silently re-registered under the caller's.
   */
  findBySerialAnyCompany(deviceSn: string): Promise<{ companyId: string } | null>;
  create(companyId: string, input: CreateAttendanceDeviceInput): Promise<AttendanceDeviceDto>;
  update(
    companyId: string,
    id: string,
    input: UpdateAttendanceDeviceInput,
  ): Promise<AttendanceDeviceDto | null>;
  remove(companyId: string, id: string): Promise<boolean>;
  /** Punches already ingested under this device's serial — a delete guard. */
  countPunches(companyId: string, deviceSn: string): Promise<number>;
  /**
   * Every active device across ALL companies, for the unattended auto-sync.
   *
   * Deliberately not company-scoped: the scheduler runs on a timer with no HTTP request and
   * therefore no `Actor` to scope by. The device rows themselves carry the tenant, so this is
   * how a background job learns which company a pulled punch belongs to.
   */
  listActiveForSync(): Promise<
    Array<{ companyId: string; deviceSn: string; defaultProjectId: string | null }>
  >;
  /** Validates `defaultProjectId` belongs to the caller's company before it is stored. */
  projectExists(companyId: string, projectId: string): Promise<boolean>;
}

export const ATTENDANCE_DEVICE_REPOSITORY = Symbol('ATTENDANCE_DEVICE_REPOSITORY');
