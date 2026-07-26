/**
 * The device→employee registry read/write port (SUPPORTING_APIS_GUIDE §7). Backed by the existing
 * `employee` table — `userId` is `employee_code` — so there is no second employee registry.
 */

/** The guide's user shape. `id` is this system's employee UUID (a string either way). */
export interface AttendanceUserDto {
  id: string;
  userId: string;
  name: string;
  designation: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertAttendanceUserInput {
  userId: string;
  name: string;
  /** `undefined` = leave as-is (partial update); `null` = clear it. */
  designation?: string | null;
}

/** Placeholders for the NOT NULL employee columns a device enrolment cannot supply. */
export interface AttendanceUserCreateDefaults {
  designation: string;
  workBase: string;
  wageType: string;
}

export const ATTENDANCE_USER_REPOSITORY = Symbol('ATTENDANCE_USER_REPOSITORY');

export interface AttendanceUserRepository {
  /** Non-deleted employees, ordered by employee code (numeric-aware). */
  list(companyId: string): Promise<AttendanceUserDto[]>;

  upsert(
    companyId: string,
    input: UpsertAttendanceUserInput,
    defaults: AttendanceUserCreateDefaults,
  ): Promise<AttendanceUserDto>;
}
