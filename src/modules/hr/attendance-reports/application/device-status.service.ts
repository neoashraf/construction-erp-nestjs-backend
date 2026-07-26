/**
 * DeviceStatusService — fingerprint-device liveness (SUPPORTING_APIS_GUIDE §4). Entirely IN-MEMORY: no
 * DB, no polling. Every `/iclock/cdata` hit (GET handshake or POST upload) stamps the last-seen state;
 * `GET /api/device/status` just answers "how long ago was that?".
 *
 * ONLINE WINDOW = 2 MINUTES. ZKTeco devices heartbeat every 30–60s, so two minutes tolerates one missed
 * beat while still catching a real disconnect quickly.
 *
 * MUST BE A SINGLETON — the default Nest provider scope. Marking it `Scope.REQUEST` would give every
 * request a fresh, empty object and the device would always read offline.
 *
 * KNOWN LIMITS, deliberately accepted (the guide calls them out too):
 *   - state resets on process restart, so a device shows `offline` until its next heartbeat;
 *   - each instance of a multi-instance deployment has its own view.
 * If either starts to matter, move `lastSeen` to Redis or `attendance_device.last_seen_at`; the shape of
 * this service does not change.
 */
import { Injectable } from '@nestjs/common';

export const DEVICE_ONLINE_WINDOW_MS = 2 * 60 * 1000;

export interface DeviceStatusDto {
  status: 'online' | 'offline';
  online: boolean;
  lastSeenAt: string | null;
  lastSeenAgeMs: number | null;
  onlineWindowMs: number;
  lastMethod: string | null;
  lastPath: string | null;
  lastRemoteAddress: string | null;
}

/** The subset of an HTTP request this service records — keeps it framework-agnostic and testable. */
export interface DeviceHit {
  method: string;
  path: string;
  remoteAddress: string | null;
  deviceSn?: string | null;
}

@Injectable()
export class DeviceStatusService {
  private lastSeenAt: Date | null = null;
  private lastMethod: string | null = null;
  private lastPath: string | null = null;
  private lastRemoteAddress: string | null = null;
  private lastDeviceSn: string | null = null;

  markSeen(hit: DeviceHit, now: Date = new Date()): void {
    this.lastSeenAt = now;
    this.lastMethod = hit.method;
    this.lastPath = hit.path;
    this.lastRemoteAddress = hit.remoteAddress;
    if (hit.deviceSn) this.lastDeviceSn = hit.deviceSn;
  }

  /** `now` is injectable for tests only; production calls it with no argument. */
  getStatus(now: Date = new Date()): DeviceStatusDto {
    const lastSeenMs = this.lastSeenAt ? this.lastSeenAt.getTime() : null;
    const ageMs = lastSeenMs === null ? null : now.getTime() - lastSeenMs;
    const online = typeof ageMs === 'number' && ageMs >= 0 && ageMs <= DEVICE_ONLINE_WINDOW_MS;

    return {
      status: online ? 'online' : 'offline',
      online,
      lastSeenAt: this.lastSeenAt ? this.lastSeenAt.toISOString() : null,
      lastSeenAgeMs: ageMs,
      onlineWindowMs: DEVICE_ONLINE_WINDOW_MS,
      lastMethod: this.lastMethod,
      lastPath: this.lastPath,
      lastRemoteAddress: this.lastRemoteAddress,
    };
  }

  get deviceSn(): string | null {
    return this.lastDeviceSn;
  }
}
