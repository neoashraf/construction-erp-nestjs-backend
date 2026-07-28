/**
 * AttendanceDeviceService — admin management of the serial→company registry.
 *
 * Registering a device is the step that makes PUSH ingestion work: `/iclock/cdata` resolves the
 * tenant from the device's `?SN=` serial via `attendance_device`, and an unregistered serial has
 * its punches DROPPED. That failure is invisible from the device's side (the endpoint must answer
 * `OK` or ZKTeco firmware retries the batch forever), so the punches are lost rather than queued.
 * Everything here exists so an admin can perform that step from the UI instead of by hand in SQL.
 *
 * VALIDATION LIVES HERE, not in a DTO: the messages are part of the contract and several of them
 * are cross-entity checks (serial uniqueness across companies, project ownership) that a
 * class-validator decorator cannot express.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  CrossCompanyReferenceError,
  NotFoundError,
  ReferencedMasterError,
  ValidationError,
} from '../../../../common/errors/domain-error';
import { Actor } from '../../../../core/tenancy/tenant-context';
import {
  ATTENDANCE_DEVICE_REPOSITORY,
  AttendanceDeviceDto,
  AttendanceDeviceRepository,
} from '../domain/ports/attendance-device.repository';

/**
 * ZKTeco serials are alphanumeric with occasional dashes. Kept permissive on purpose — vendors
 * vary — but whitespace and punctuation are rejected because a serial with a stray space silently
 * never matches the `?SN=` the device sends, which is the exact failure this screen prevents.
 */
const SERIAL_PATTERN = /^[A-Za-z0-9-]{4,64}$/;
const MAX_LABEL = 120;

function validation(message: string): ValidationError {
  return new ValidationError(message);
}

/** Trim to a string, treating blank/absent alike as `null`. */
function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw validation(`${field} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw validation(`${field} must be at most ${max} characters`);
  return text;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw validation(`${field} must be a string`);
  const text = value.trim();
  return text ? text : null;
}

export interface CreateDeviceRequest {
  deviceSn?: unknown;
  label?: unknown;
  defaultProjectId?: unknown;
}

export interface UpdateDeviceRequest {
  label?: unknown;
  defaultProjectId?: unknown;
  isActive?: unknown;
}

@Injectable()
export class AttendanceDeviceService {
  constructor(
    @Inject(ATTENDANCE_DEVICE_REPOSITORY)
    private readonly repo: AttendanceDeviceRepository,
  ) {}

  list(actor: Actor): Promise<AttendanceDeviceDto[]> {
    return this.repo.list(actor.companyId);
  }

  async create(body: CreateDeviceRequest, actor: Actor): Promise<AttendanceDeviceDto> {
    const deviceSn = this.assertSerial(body.deviceSn);
    const label = optionalText(body.label, 'label', MAX_LABEL);
    const defaultProjectId = await this.assertProject(body.defaultProjectId, actor.companyId);

    // `device_sn` is globally UNIQUE, so a serial held by ANOTHER company must surface as a
    // conflict. Letting the raw constraint violation escape would produce a 500 and an opaque
    // Postgres message; this says which case it is without naming the other tenant.
    const existing = await this.repo.findBySerialAnyCompany(deviceSn);
    if (existing) {
      throw new ConflictError(
        existing.companyId === actor.companyId
          ? `Device serial ${deviceSn} is already registered`
          : `Device serial ${deviceSn} is already registered to another company`,
      );
    }

    return this.repo.create(actor.companyId, { deviceSn, label, defaultProjectId });
  }

  async update(id: string, body: UpdateDeviceRequest, actor: Actor): Promise<AttendanceDeviceDto> {
    // Only keys PRESENT in the body are forwarded: `undefined` leaves a column untouched while an
    // explicit `null` clears it. The serial itself is intentionally NOT editable — punches in
    // `checkin_log` reference it, so changing it would orphan existing history. Delete and
    // re-register instead.
    const patch: { label?: string | null; defaultProjectId?: string | null; isActive?: boolean } =
      {};

    if (body.label !== undefined) patch.label = optionalText(body.label, 'label', MAX_LABEL);
    if (body.defaultProjectId !== undefined) {
      patch.defaultProjectId = await this.assertProject(body.defaultProjectId, actor.companyId);
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') throw validation('isActive must be a boolean');
      patch.isActive = body.isActive;
    }

    const updated = await this.repo.update(actor.companyId, id, patch);
    if (!updated) throw new NotFoundError('Device not found');
    return updated;
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const device = await this.repo.findById(actor.companyId, id);
    if (!device) throw new NotFoundError('Device not found');

    // Punches already ingested under this serial would lose the row that explains where they
    // came from, and a re-registration could re-attribute that history to a different company.
    // Deactivating stops ingestion without touching what is already recorded.
    const punches = await this.repo.countPunches(actor.companyId, device.deviceSn);
    if (punches > 0) {
      throw new ReferencedMasterError(
        `Device has ${punches} recorded punch(es) and cannot be deleted — deactivate it instead`,
      );
    }

    await this.repo.remove(actor.companyId, id);
  }

  private assertSerial(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw validation('deviceSn is required');
    const deviceSn = value.trim();
    if (!SERIAL_PATTERN.test(deviceSn)) {
      throw validation(
        'deviceSn must be 4-64 characters, letters, digits and dashes only (as printed on the device)',
      );
    }
    return deviceSn;
  }

  /** Null is valid — see the controller doc on what an empty default project means. */
  private async assertProject(value: unknown, companyId: string): Promise<string | null> {
    const projectId = optionalUuid(value, 'defaultProjectId');
    if (!projectId) return null;
    if (!(await this.repo.projectExists(companyId, projectId))) {
      throw new CrossCompanyReferenceError('defaultProjectId does not belong to this company');
    }
    return projectId;
  }
}
