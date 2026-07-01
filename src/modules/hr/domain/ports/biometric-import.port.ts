/**
 * BiometricImportPort (HR adapter, driven). Parses an office-staff attendance feed — CSV/XLSX file or a
 * device-API payload — into a normalised set of rows the attendance service reconciles to one OFFICE row
 * per employee per day (FR-HR-004; edge §12.9). Phase 1 defaults to file import (SKILL.md §14); a device
 * adapter slots behind the same port later (SRS §16). PURE interface.
 */
import { DayStatus } from '../attendance-record';

export interface BiometricAttendanceRow {
  employeeCode: string;
  attendanceDate: string; // 'YYYY-MM-DD'
  checkIn?: string | null; // 'HH:mm'
  checkOut?: string | null;
  dayStatus?: DayStatus | null;
  overtimeHours?: string | null;
}

export interface BiometricFeed {
  /** Raw file buffer (CSV/XLSX) OR an already-decoded device payload — one of the two is supplied. */
  file?: Buffer;
  fileName?: string;
  deviceFeed?: BiometricAttendanceRow[];
}

export interface BiometricImportPort {
  parse(feed: BiometricFeed): Promise<BiometricAttendanceRow[]>;
}

export const BIOMETRIC_IMPORT_PORT = Symbol('BiometricImportPort');
