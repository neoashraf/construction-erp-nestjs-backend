/**
 * ZKTeco pull adapter (TRANSFER_PROMPT §3.8) — the only file that touches `node-zklib`.
 *
 * Pulls the roster and punch history over ONE socket and always disconnects in a `finally`:
 * the device allows very few concurrent connections and a leaked socket blocks the next sync
 * until the firmware times it out.
 *
 * FIRMWARE COMPATIBILITY is the bulk of this file. Field naming varies across ZK firmwares
 * and the SDK passes objects through largely untouched, so every field is read through an
 * alias list and coerced to a trimmed string — some firmwares send numbers, others strings.
 * A single hard-coded key would silently yield zero rows on half the devices in the field.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDeviceConfig, type DeviceConfig } from '../../../../config/app-config';
import {
  DeviceNotConfiguredError,
  DeviceUnreachableError,
  type DevicePullResult,
  type DevicePuller,
  type DevicePunch,
  type DeviceRosterEntry,
} from '../domain/ports/device-puller.port';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ZKLib = require('node-zklib') as new (
  ip: string,
  port: number,
  timeout: number,
  inport: number,
) => ZkClient;

/** The slice of the `node-zklib` surface this adapter uses. */
interface ZkClient {
  createSocket(): Promise<void>;
  getUsers(): Promise<unknown>;
  getAttendances(): Promise<unknown>;
  disconnect(): Promise<void>;
}

/** Device user-id keys seen across firmwares, in priority order. */
const USER_ID_KEYS = [
  'deviceUserId',
  'deviceuserid',
  'device_user_id',
  'userId',
  'userid',
  'user_id',
  'pin',
  'uid',
];
const NAME_KEYS = ['name', 'username', 'user_name'];
const TIME_KEYS = ['recordTime', 'record_time', 'timestamp', 'time'];
const STATUS_KEYS = ['status', 'state', 'verify', 'verifyMode', 'type'];

/**
 * SDK calls resolve to either a bare array or `{ data: [...] }` depending on the call and
 * firmware. Unwrap both; anything else yields an empty list rather than throwing.
 */
function unwrapRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data as Record<string, unknown>[];
  }
  return [];
}

/** First non-empty value among `keys`, coerced to a trimmed string. */
function readAlias(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value.trim() : String(value).trim();
    if (text) return text;
  }
  return '';
}

const PAD = (n: number) => String(n).padStart(2, '0');

/**
 * Render a Date as `"YYYY-MM-DD HH:mm:ss"` in the SERVER's local zone.
 *
 * This is the conversion the transfer prompt flags as subtle and verified. The SDK returns
 * punches as real UTC instants (`2026-07-09T08:01:36.000Z`), whereas punches arriving on
 * `/iclock/cdata` are already local wall-clock text with no zone. Rendering the pulled
 * instant into local components puts both sources in the same representation, which is what
 * makes `(userId, deviceTimestamp)` a reliable dedupe key across ingestion paths.
 *
 * CONSEQUENCE: the server's timezone must match the device's. If they differ, pulled and
 * pushed punches for the same event will disagree by the offset and both will be stored.
 */
export function formatLocalWallClock(date: Date): string {
  return (
    `${date.getFullYear()}-${PAD(date.getMonth() + 1)}-${PAD(date.getDate())} ` +
    `${PAD(date.getHours())}:${PAD(date.getMinutes())}:${PAD(date.getSeconds())}`
  );
}

/** Already-local wall-clock text, as some firmwares report it. */
const WALL_CLOCK_TEXT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Normalise whatever the SDK gave us for a punch time into local wall-clock text.
 *
 * A bare `"YYYY-MM-DD HH:mm:ss"` string carries no zone, so it is kept VERBATIM — reparsing
 * it as UTC would shift it. Only real instants (Date, or an ISO string with a zone) are
 * converted.
 */
export function normalisePunchTime(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : formatLocalWallClock(value);
  }

  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  if (!text) return null;

  const wall = WALL_CLOCK_TEXT.exec(text);
  if (wall) {
    // Zone-less: keep as-is, padding a missing seconds field.
    const [, y, mo, d, h, mi, s] = wall;
    return `${y}-${mo}-${d} ${h}:${mi}:${s ?? '00'}`;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : formatLocalWallClock(parsed);
}

@Injectable()
export class ZkDevicePullerAdapter implements DevicePuller {
  private readonly logger = new Logger(ZkDevicePullerAdapter.name);
  private readonly config: DeviceConfig;

  constructor(@Inject(ConfigService) configService: ConfigService) {
    this.config = getDeviceConfig(configService);
  }

  isConfigured(): boolean {
    return this.config.ip.trim().length > 0;
  }

  target(): { ip: string; port: number } {
    return { ip: this.config.ip, port: this.config.port };
  }

  async pull(): Promise<DevicePullResult> {
    if (!this.isConfigured()) throw new DeviceNotConfiguredError();

    const { ip, port, timeoutMs, inPort } = this.config;
    const address = `${ip}:${port}`;
    const client = new ZKLib(ip, port, timeoutMs, inPort);

    let connected = false;
    try {
      await client.createSocket();
      connected = true;

      // Both pulls share the one connection — reconnecting per call doubles the time the
      // device spends locked and is a common cause of mid-sync drops.
      const rawUsers = await client.getUsers();
      const rawPunches = await client.getAttendances();

      const roster = this.mapRoster(unwrapRows(rawUsers));
      const punches = this.mapPunches(unwrapRows(rawPunches));

      this.logger.log(
        `Device ${address}: pulled ${roster.length} roster entr(ies), ${punches.length} punch(es)`,
      );
      return { roster, punches };
    } catch (error) {
      if (error instanceof DeviceNotConfiguredError) throw error;
      this.logger.error(
        `Device ${address}: pull failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new DeviceUnreachableError(address, error);
    } finally {
      if (connected) {
        // Never let a disconnect failure mask the real error, but never skip it either.
        await client.disconnect().catch(() => undefined);
      }
    }
  }

  private mapRoster(rows: Record<string, unknown>[]): DeviceRosterEntry[] {
    const entries: DeviceRosterEntry[] = [];
    for (const row of rows) {
      const userId = readAlias(row, USER_ID_KEYS);
      if (!userId) continue; // nothing to key on
      entries.push({ userId, name: readAlias(row, NAME_KEYS) });
    }
    return entries;
  }

  private mapPunches(rows: Record<string, unknown>[]): DevicePunch[] {
    const punches: DevicePunch[] = [];
    let unusable = 0;

    for (const row of rows) {
      const userId = readAlias(row, USER_ID_KEYS);
      const timestamp = normalisePunchTime(
        TIME_KEYS.map((k) => row[k]).find((v) => v !== undefined && v !== null),
      );
      if (!userId || !timestamp) {
        unusable += 1;
        continue;
      }
      punches.push({
        userId,
        deviceTimestamp: timestamp,
        status: readAlias(row, STATUS_KEYS) || '0',
      });
    }

    if (unusable > 0) {
      this.logger.warn(`Device pull: ${unusable} punch row(s) had no usable user id or time`);
    }
    return punches;
  }
}
