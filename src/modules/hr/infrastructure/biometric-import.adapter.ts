/**
 * CsvBiometricImportAdapter (INFRASTRUCTURE) — implements BiometricImportPort for the Phase-1 default:
 * file import (CSV) or an already-decoded device-API payload (SKILL.md §14; SRS §16). Parses a simple
 * CSV with a header row `employeeCode,attendanceDate,checkIn,checkOut,dayStatus,overtimeHours`; a device
 * feed is passed straight through. XLSX / concrete device APIs slot behind this same port later.
 */
import { Injectable } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/domain-error';
import { DayStatus } from '../domain/attendance-record';
import {
  BiometricAttendanceRow,
  BiometricFeed,
  BiometricImportPort,
} from '../domain/ports/biometric-import.port';

const CSV_COLUMNS = [
  'employeeCode',
  'attendanceDate',
  'checkIn',
  'checkOut',
  'dayStatus',
  'overtimeHours',
] as const;

@Injectable()
export class CsvBiometricImportAdapter implements BiometricImportPort {
  async parse(feed: BiometricFeed): Promise<BiometricAttendanceRow[]> {
    if (feed.deviceFeed) return feed.deviceFeed;
    if (!feed.file) {
      throw new ValidationError('biometric import requires a file or a deviceFeed', {});
    }
    return this.parseCsv(feed.file.toString('utf8'));
  }

  private parseCsv(text: string): BiometricAttendanceRow[] {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];
    const header = lines[0].split(',').map((h) => h.trim());
    const idx = (name: string) => header.indexOf(name);
    if (idx('employeeCode') < 0 || idx('attendanceDate') < 0) {
      throw new ValidationError('CSV must have employeeCode and attendanceDate columns', {
        expected: CSV_COLUMNS,
      });
    }
    const rows: BiometricAttendanceRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',').map((c) => c.trim());
      const at = (name: string): string | null => {
        const j = idx(name);
        return j >= 0 && cells[j] ? cells[j] : null;
      };
      const employeeCode = at('employeeCode');
      const attendanceDate = at('attendanceDate');
      if (!employeeCode || !attendanceDate) {
        throw new ValidationError(`CSV row ${i + 1} is missing employeeCode/attendanceDate`, { line: i + 1 });
      }
      rows.push({
        employeeCode,
        attendanceDate,
        checkIn: at('checkIn'),
        checkOut: at('checkOut'),
        dayStatus: (at('dayStatus') as DayStatus | null) ?? null,
        overtimeHours: at('overtimeHours'),
      });
    }
    return rows;
  }
}
