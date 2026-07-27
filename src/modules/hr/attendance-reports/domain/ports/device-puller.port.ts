/**
 * The device PULL port — one connection, roster + punch history (TRANSFER_PROMPT §3.8).
 *
 * Kept as a port so the ZK protocol library stays at the infrastructure edge: the sync
 * use-case depends on this interface, never on `node-zklib`. That also makes the use-case
 * testable without a device on the LAN.
 *
 * This is the counterpart to push ingestion (`/iclock/cdata`), not a replacement: push is
 * real-time and works from anywhere, pull backfills history and repairs missed punches but
 * requires direct LAN reachability to the device.
 */

/** One enrolled person as the device reports them. */
export interface DeviceRosterEntry {
  /** Device enrollment number — the join key to `employee.employee_code`. */
  userId: string;
  /** Device-held name; may be blank on unnamed enrollments. */
  name: string;
}

/** One punch as the device reports it, normalised to local wall-clock text. */
export interface DevicePunch {
  userId: string;
  /**
   * `"YYYY-MM-DD HH:mm:ss"` in the SERVER's local zone.
   *
   * The SDK hands back real UTC instants, while pushed rows arrive already as local
   * wall-clock. Converting on the way in is what lets the two sources compare and dedupe as
   * plain strings — see `formatLocalWallClock`.
   */
  deviceTimestamp: string;
  /** Raw device state code (verify mode / in-out flag); kept verbatim. */
  status: string;
}

export interface DevicePullResult {
  roster: DeviceRosterEntry[];
  punches: DevicePunch[];
}

/** Raised when the device cannot be reached — surfaces as 502. */
export class DeviceUnreachableError extends Error {
  constructor(address: string, cause?: unknown) {
    super(
      `Could not reach the attendance device at ${address}: ` +
        (cause instanceof Error ? cause.message : String(cause ?? 'no response')),
    );
    this.name = 'DeviceUnreachableError';
  }
}

/** Raised when no device address is configured — surfaces as 503. */
export class DeviceNotConfiguredError extends Error {
  constructor() {
    super('DEVICE_IP is not configured on the server; manual sync is unavailable');
    this.name = 'DeviceNotConfiguredError';
  }
}

export const DEVICE_PULLER = Symbol('DEVICE_PULLER');

export interface DevicePuller {
  /** True when a device address is configured (drives the 503 vs. attempt decision). */
  isConfigured(): boolean;

  /** The configured target, for status reporting. */
  target(): { ip: string; port: number };

  /**
   * Open one socket, pull the roster and punch history, and always disconnect.
   * Throws `DeviceNotConfiguredError` / `DeviceUnreachableError`.
   */
  pull(): Promise<DevicePullResult>;
}
