/**
 * AttendanceSettingService — the late cut-off behind `/api/settings/attendance`
 * (SUPPORTING_APIS_GUIDE §6). This is the value `/api/reports/*` reports as `lateAfter` and uses to
 * decide Present vs Late, so it is not an optional extra: without it the threshold can never be changed
 * from the 09:30 default.
 *
 * Reading a company that has no row returns the 09:30 default with `updatedAt: null` rather than 404 —
 * an un-configured (or un-seeded) database still serves reports, which is the whole point of the
 * fallback. The two integers are the source of truth; `lateAfter` is derived for display.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { formatLateAfter, normalizeTimeUnit } from '../domain/holiday-rules';
import {
  ATTENDANCE_CONFIG_REPOSITORY,
  AttendanceConfigRepository,
} from '../domain/ports/attendance-config.repository';

/** Used when the company has no `attendance_setting` row. Mirrors the read adapter's fallback. */
const DEFAULT_THRESHOLD = { lateAfterHour: 9, lateAfterMinute: 30 };

export interface AttendanceSettingDto {
  lateAfterHour: number;
  lateAfterMinute: number;
  lateAfter: string;
  updatedAt: Date | null;
}

@Injectable()
export class AttendanceSettingService {
  constructor(
    @Inject(ATTENDANCE_CONFIG_REPOSITORY) private readonly repo: AttendanceConfigRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async get(actor: Actor): Promise<AttendanceSettingDto> {
    const row = await this.repo.findSetting(actor.companyId);
    const setting = row ?? { ...DEFAULT_THRESHOLD, updatedAt: null };
    return this.toDto(setting.lateAfterHour, setting.lateAfterMinute, setting.updatedAt);
  }

  /** Validation throws the guide's exact 400 messages before anything is written. */
  async set(
    input: { lateAfterHour?: unknown; lateAfterMinute?: unknown },
    actor: Actor,
  ): Promise<AttendanceSettingDto> {
    const hour = normalizeTimeUnit(input.lateAfterHour, 23, 'lateAfterHour');
    const minute = normalizeTimeUnit(input.lateAfterMinute, 59, 'lateAfterMinute');

    return this.uow.run(async () => {
      const saved = await this.repo.upsertSetting(actor.companyId, hour, minute);
      return this.toDto(saved.lateAfterHour, saved.lateAfterMinute, saved.updatedAt);
    });
  }

  private toDto(hour: number, minute: number, updatedAt: Date | null): AttendanceSettingDto {
    return {
      lateAfterHour: hour,
      lateAfterMinute: minute,
      lateAfter: formatLateAfter(hour, minute),
      updatedAt,
    };
  }
}
