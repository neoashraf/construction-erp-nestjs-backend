/**
 * Spreadsheet-import normaliser. PURE — no NestJS, no DB, no I/O, no `xlsx`.
 *
 * The browser turns the workbook into JSON rows; this decides what those rows MEAN. Keeping
 * the meaning here (rather than in the React component that read the file) is what lets the
 * server enforce the same rules for a row that arrives from a script or a future direct
 * upload — the client is a convenience, never the validator.
 *
 * ── Why the sheet carries TIMES and not statuses ──────────────────────────────────────────
 * Present / Late / Absent are DERIVED downstream from the punch times against the company's
 * `attendance_setting` late threshold. If the sheet were allowed to assert a status, an
 * imported day and a device day covering the same employee could disagree — the sheet would
 * say "Present" while the engine, reading the same 10:42 check-in, computed "Late". Reports
 * would then contradict themselves depending on how the day happened to arrive. So an import
 * supplies exactly what a fingerprint terminal supplies (who, when) and nothing more.
 *
 * ── Why one row becomes up to TWO punches ─────────────────────────────────────────────────
 * `checkin_log` is a punch log, not a day table: reconciliation recomputes each day as
 * MIN/MAX over the punches. An import row is a *day* (check-in + check-out), so it expands
 * into two punch rows. That is what makes an imported day and a device day identical once
 * stored — and it is why re-importing a day the device later reports adds nothing: both paths
 * dedupe on the same `(company, user, deviceTimestamp)` key.
 */

/** One spreadsheet row as the client read it — every cell still a raw string. */
export interface RawImportRow {
  /** Employee code as enrolled on the device (`employee.employee_code`). */
  userId?: string;
  /** `YYYY-MM-DD`. */
  date?: string;
  /** `HH:mm` or `HH:mm:ss`. */
  checkIn?: string;
  checkOut?: string;
}

/** A normalised punch ready for `checkin_log`; `deviceTimestamp` is the storage key. */
export interface ImportPunch {
  userId: string;
  /** `'YYYY-MM-DD HH:mm:ss'` — the same text shape the device sends. */
  deviceTimestamp: string;
  /** ZKTeco convention: `0` = check-in, `1` = check-out. */
  status: string;
}

/** A row that could not be used, with the 1-based sheet row number so the user can find it. */
export interface ImportRowError {
  row: number;
  message: string;
}

export interface ParsedImport {
  punches: ImportPunch[];
  errors: ImportRowError[];
  /** Rows that produced at least one punch — what the user thinks of as "imported". */
  acceptedRows: number;
  /** Rows that were entirely blank; skipped in silence, never reported as an error. */
  blankRows: number;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** True when every cell in the row is empty — trailing spreadsheet filler, not a mistake. */
function isBlank(row: RawImportRow): boolean {
  return !(row.userId ?? '').trim() && !(row.date ?? '').trim() &&
    !(row.checkIn ?? '').trim() && !(row.checkOut ?? '').trim();
}

/**
 * Validate `YYYY-MM-DD` as a real calendar date.
 *
 * The regex alone accepts `2026-02-31`; round-tripping through `Date` rejects it. Without
 * this a typo becomes a punch on a day that does not exist, which then never matches any
 * report window and looks like data loss rather than a bad row.
 */
function normaliseDate(value: string): string | null {
  const match = DATE.exec(value.trim());
  if (!match) return null;

  const [, y, m, d] = match as unknown as string[];
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return `${y}-${m}-${d}`;
}

/** `9:05` → `09:05:00`. Seconds are optional because nobody types them. */
function normaliseTime(value: string): string | null {
  const match = TIME.exec(value.trim());
  if (!match) return null;

  const [, h, m, s] = match as unknown as string[];
  const hour = Number(h);
  const minute = Number(m);
  const second = s === undefined ? 0 : Number(s);
  if (hour > 23 || minute > 59 || second > 59) return null;

  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/**
 * Normalise spreadsheet rows into punches.
 *
 * Per-row errors are COLLECTED, not thrown. A 500-row month with three typos should import
 * 497 rows and tell the user precisely which three to fix — rejecting the file outright would
 * make the operator hunt for the bad row by bisection. (The holiday import takes the opposite
 * line, and deliberately: a partially-imported holiday calendar silently corrupts every
 * working-day count that reads it, whereas a missing attendance row is visibly missing.)
 */
export function parseImportRows(rows: readonly RawImportRow[]): ParsedImport {
  const punches: ImportPunch[] = [];
  const errors: ImportRowError[] = [];
  let acceptedRows = 0;
  let blankRows = 0;

  rows.forEach((row, index) => {
    // +2: the header occupies sheet row 1, so data row 0 is what the user sees as row 2.
    const rowNumber = index + 2;

    if (isBlank(row)) {
      blankRows += 1;
      return;
    }

    const userId = (row.userId ?? '').trim();
    if (!userId) {
      errors.push({ row: rowNumber, message: 'Employee ID is required' });
      return;
    }

    const date = normaliseDate(row.date ?? '');
    if (!date) {
      errors.push({
        row: rowNumber,
        message: `Invalid date '${(row.date ?? '').trim()}' — expected YYYY-MM-DD`,
      });
      return;
    }

    const checkInText = (row.checkIn ?? '').trim();
    const checkOutText = (row.checkOut ?? '').trim();

    // A row with a date but no times asserts nothing. It cannot mean "absent" either: absence
    // is the ABSENCE of punches, which is already true without importing anything. Storing a
    // timeless row would create a phantom present-day with no check-in.
    if (!checkInText && !checkOutText) {
      errors.push({ row: rowNumber, message: 'At least one of Check In / Check Out is required' });
      return;
    }

    const checkIn = checkInText ? normaliseTime(checkInText) : null;
    if (checkInText && !checkIn) {
      errors.push({ row: rowNumber, message: `Invalid check-in time '${checkInText}' — expected HH:mm` });
      return;
    }

    const checkOut = checkOutText ? normaliseTime(checkOutText) : null;
    if (checkOutText && !checkOut) {
      errors.push({ row: rowNumber, message: `Invalid check-out time '${checkOutText}' — expected HH:mm` });
      return;
    }

    // Reconciliation takes MIN/MAX over the day, so a reversed pair would silently swap the
    // two rather than fail — the day would read as arriving at 18:00 and leaving at 09:00.
    // Rejecting it keeps the mistake visible while it is still fixable in the sheet.
    if (checkIn && checkOut && checkOut < checkIn) {
      errors.push({
        row: rowNumber,
        message: `Check-out ${checkOut} is before check-in ${checkIn}`,
      });
      return;
    }

    if (checkIn) punches.push({ userId, deviceTimestamp: `${date} ${checkIn}`, status: '0' });
    // An identical check-out is not a second punch — it is the same event written twice, and
    // the storage key would collide anyway. Dropping it here keeps the counts honest.
    if (checkOut && checkOut !== checkIn) {
      punches.push({ userId, deviceTimestamp: `${date} ${checkOut}`, status: '1' });
    }

    acceptedRows += 1;
  });

  return { punches, errors, acceptedRows, blankRows };
}
