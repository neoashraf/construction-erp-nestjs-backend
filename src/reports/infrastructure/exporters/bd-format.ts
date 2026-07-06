/**
 * bd-format (RPT · FR-RPT-030) — PURE, shared Bangladesh render helpers for the Excel/PDF exporters. No
 * NestJS, no TypeORM, no I/O. These render the format-neutral `ReportResult` for human display WITHOUT
 * losing precision: money keeps its full `Decimal(18,4)` value (thousands grouping is cosmetic only), and
 * the raw string handed in always round-trips to the same numeric value the JSON export carries
 * (FR-RPT-029). Dates render `DD/MM/YYYY`; Bangla text is passed through UTF-8, never truncated.
 */
import Decimal from 'decimal.js';
import { CompanyHeader } from '../../domain/ports/file-exporter.port';

/** Row keys that carry money (`Decimal(18,4)` decimal strings). Rendered with `taka(...)` in the PDF. */
export const MONEY_KEYS = new Set<string>([
  'debit',
  'credit',
  'net',
  'revenue',
  'cost',
  'profit',
  'balance',
  'runningBalance',
  'openingBalance',
  'amount',
  // Inventory / HR / requisition report money & rate columns (RPT #31).
  'totalValue',
  'weightedAverageRate',
  'value',
  'gross',
  'allowances',
  'tds',
  'pf',
  'advanceRecovery',
  'other',
  'paidAmount',
  // Project report money columns (RPT #32).
  'certifiedAmount',
  'billedAmount',
  'receivedAmount',
  'outstandingAmount',
  'retentionHeld',
  'budgetedAmount',
  'actualCost',
  'variance',
  'labourCost',
]);

/** Row keys that carry an ISO date/timestamp — rendered `DD/MM/YYYY`. */
export const DATE_KEYS = new Set<string>([
  'voucherDate',
  'date',
  'asOf',
  'dateFrom',
  'dateTo',
  'asOfDate',
  'paymentDate',
  // Project report date columns (RPT #32).
  'ipcDate',
  'dueDate',
]);

export const isMoneyKey = (key: string): boolean => MONEY_KEYS.has(key);
export const isDateKey = (key: string): boolean => DATE_KEYS.has(key);

/**
 * Format a `Decimal(18,4)` decimal string as a Bangladeshi taka display string. Keeps all four decimal
 * places and never rounds/loses precision (parsed via decimal.js, not JS float); the underlying numeric
 * value equals the JSON value. Thousands grouping is display-only. Empty/nullish → ''.
 */
export function taka(decimalString: string | number | null | undefined): string {
  if (decimalString === null || decimalString === undefined || decimalString === '') return '';
  const d = new Decimal(decimalString);
  const fixed = d.toFixed(4); // exact 4dp, no float
  const negative = fixed.startsWith('-');
  const [intPart, frac] = (negative ? fixed.slice(1) : fixed).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}৳${grouped}.${frac}`;
}

function isoParts(iso: string): { dd: string; mm: string; yyyy: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.slice(0, 10));
  return m ? { yyyy: m[1], mm: m[2], dd: m[3] } : null;
}

/** Render an ISO date/timestamp ('YYYY-MM-DD' or full ISO-8601) as `DD/MM/YYYY`. Passthrough if unparsable. */
export function formatDateDDMMYYYY(isoDate: string | null | undefined): string {
  if (!isoDate) return '';
  const p = isoParts(isoDate);
  return p ? `${p.dd}/${p.mm}/${p.yyyy}` : isoDate;
}

/** The statutory company identity block (name / legal name / address / BIN + TIN) for NBR-acceptable output. */
export function binTinBlock(company: CompanyHeader): string[] {
  const lines: string[] = [company.name];
  if (company.legalName && company.legalName !== company.name) lines.push(company.legalName);
  if (company.address) lines.push(company.address);
  lines.push(`BIN: ${company.bin}    TIN: ${company.tin}`);
  return lines;
}

/** Union of row keys, preserving first-seen order — the export's columns for a format-neutral row model. */
export function deriveColumns<Row>(rows: Row[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  return cols;
}

/** Humanise a camelCase key into a column header, e.g. `accountId` → `Account Id`. */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Sanitise a filename segment: keep alphanumerics/`-`/`_`, collapse everything else to `-`. */
function safeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
}

/**
 * Deterministic, safe download filename: `<reportName>-<scope>-<DD-MM-YYYY>.<ext>`. Scope is the short
 * project id when project-scoped, else 'consolidated'. The date is the report's asOf/dateTo, else today.
 */
export function exportFilename(
  reportName: string,
  params: Record<string, unknown>,
  ext: string,
): string {
  const projectId = typeof params.projectId === 'string' ? params.projectId : null;
  const scope = projectId ? projectId.slice(0, 8) : 'consolidated';
  const dateSrc =
    (typeof params.asOf === 'string' && params.asOf) ||
    (typeof params.dateTo === 'string' && params.dateTo) ||
    new Date().toISOString();
  const p = isoParts(dateSrc);
  const datePart = p ? `${p.dd}-${p.mm}-${p.yyyy}` : 'undated';
  return `${safeSegment(reportName)}-${safeSegment(scope)}-${datePart}.${ext}`;
}
