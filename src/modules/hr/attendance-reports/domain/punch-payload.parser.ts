/**
 * ZKTeco punch-payload parser (SUPPORTING_APIS_GUIDE §5.3). PURE — no NestJS, no DB, no I/O.
 *
 * Device firmware varies, so four line formats are tried in order and the first that matches wins:
 *   1. Key-value, tab separated   `PIN=1042\tDateTime=2026-07-26 09:12:04\tStatus=0`
 *   2. ATTLOG prefixed            `ATTLOG 1042 2026-07-26 09:12:04 0`
 *   3. Tab separated              `1042\t2026-07-26 09:12:04\t0`
 *   4. Comma separated            `1042,2026-07-26 09:12:04,0`
 * Key-value accepts vendor aliases (`pin`/`userid`/`enrollnumber`/`personnelid`;
 * `datetime`/`time`/`timestamp`) because the key names differ between firmwares.
 *
 * DESIGN RULE — one malformed line never fails the batch. Unparseable lines go to `ignoredLines` and
 * everything else is saved, so a single corrupt punch cannot cost a whole day of attendance.
 */

/** One punch as the device reported it. `timestamp` is kept as raw text (see the migration). */
export interface ParsedPunch {
  type: string;
  userId: string;
  timestamp: string;
  status: string;
}

export interface ParsedPayload {
  records: ParsedPunch[];
  ignoredLines: string[];
}

function normalizeLineEndings(rawBody: string): string {
  return rawBody.replace(/\r/g, '');
}

function parseKeyValueLine(line: string): ParsedPunch | null {
  const segments = line.split('\t').map((s) => s.trim()).filter(Boolean);
  if (!segments.some((segment) => segment.includes('='))) return null;

  const values: Record<string, string> = {};
  for (const segment of segments) {
    const separatorIndex = segment.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = segment.slice(0, separatorIndex).trim().toLowerCase();
    const value = segment.slice(separatorIndex + 1).trim();
    if (key) values[key] = value;
  }

  const userId = values.pin || values.userid || values.enrollnumber || values.personnelid;
  const timestamp = values.datetime || values.time || values.timestamp;
  const status = values.status || values.state || values.verify || '0';

  if (!userId || !timestamp) return null;

  return { type: values.table || values.event || 'ATTLOG', userId, timestamp, status };
}

function parseAttlogLine(line: string): ParsedPunch | null {
  if (!line.startsWith('ATTLOG')) return null;

  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;

  return {
    type: 'ATTLOG',
    userId: parts[1] as string,
    timestamp: `${parts[2]} ${parts[3]}`,
    status: parts[4] as string,
  };
}

function parseTabSeparatedLine(line: string): ParsedPunch | null {
  const parts = line.split('\t').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  if (/^[A-Z]+LOG/i.test(parts[0] as string)) return null;

  return {
    type: 'TAB',
    userId: parts[0] as string,
    timestamp: parts[1] as string,
    status: parts[2] as string,
  };
}

function parseCommaSeparatedLine(line: string): ParsedPunch | null {
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length !== 3) return null;
  if (!/^\d+$/.test(parts[0] as string)) return null;

  return {
    type: 'CSV',
    userId: parts[0] as string,
    timestamp: parts[1] as string,
    status: parts[2] as string,
  };
}

export function parseAttendancePayload(rawBody: string): ParsedPayload {
  const normalizedBody = normalizeLineEndings(rawBody || '');
  const lines = normalizedBody.split('\n').map((l) => l.trim()).filter(Boolean);

  const records: ParsedPunch[] = [];
  const ignoredLines: string[] = [];

  for (const line of lines) {
    // Some firmwares echo a raw HTTP request line into the body; it is noise, not a punch.
    if (line.startsWith('GET ') || line.startsWith('POST ')) {
      ignoredLines.push(line);
      continue;
    }

    const record =
      parseKeyValueLine(line) ||
      parseAttlogLine(line) ||
      parseTabSeparatedLine(line) ||
      parseCommaSeparatedLine(line);

    if (!record) {
      ignoredLines.push(line);
      continue;
    }

    records.push(record);
  }

  return { records, ignoredLines };
}

const DEVICE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Parse `'YYYY-MM-DD HH:mm:ss'` into a Date for the convenience `occurred_at` column. Returns null for
 * anything else — a punch with an unparseable timestamp is still STORED (its raw text is the truth),
 * it just gets no parsed copy.
 */
export function parseDeviceTimestamp(timestamp: string): Date | null {
  const match = DEVICE_TIMESTAMP.exec(timestamp);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match as unknown as string[];
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
}

/** The calendar date of a punch — the leading ten characters, no timezone maths. */
export function punchDayKey(timestamp: string): string | null {
  const day = String(timestamp ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** The `HH:mm:ss` of a punch, for the `attendance_record.check_in` / `check_out` time columns. */
export function punchTimeOfDay(timestamp: string): string | null {
  const match = DEVICE_TIMESTAMP.exec(String(timestamp ?? ''));
  return match ? `${match[4]}:${match[5]}:${match[6]}` : null;
}
