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
import { badRequest } from '../domain/attendance-rules';
import { formatLateAfter, normalizeTimeUnit } from '../domain/holiday-rules';
import {
  ATTENDANCE_CONFIG_REPOSITORY,
  AttendanceConfigRepository,
} from '../domain/ports/attendance-config.repository';

/** Used when the company has no `attendance_setting` row. Mirrors the read adapter's fallback. */
const DEFAULT_THRESHOLD = { lateAfterHour: 9, lateAfterMinute: 30, latesPerDeductedDay: 3 };

export interface AttendanceSettingDto {
  lateAfterHour: number;
  lateAfterMinute: number;
  lateAfter: string;
  /** N lates cost one day's pay (FR-HR-013a). Same row as the threshold, so the report and the
   *  salary sheet can never disagree about it (FR-HR-008c). */
  latesPerDeductedDay: number;
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
    return this.toDto(setting);
  }

  /** Validation throws the guide's exact 400 messages before anything is written. */
  async set(
    input: { lateAfterHour?: unknown; lateAfterMinute?: unknown; latesPerDeductedDay?: unknown },
    actor: Actor,
  ): Promise<AttendanceSettingDto> {
    const hour = normalizeTimeUnit(input.lateAfterHour, 23, 'lateAfterHour');
    const minute = normalizeTimeUnit(input.lateAfterMinute, 59, 'lateAfterMinute');
    // Undefined means "leave it alone" — the endpoint is partial. 0 is rejected rather than
    // defaulted: it would divide by zero in `penaltyDays`, and silently substituting 3 would change
    // everyone's pay without the caller asking.
    const lates =
      input.latesPerDeductedDay === undefined || input.latesPerDeductedDay === null
        ? undefined
        : normalizeLatesPerDay(input.latesPerDeductedDay);

    return this.uow.run(async () => {
      const saved = await this.repo.upsertSetting(actor.companyId, hour, minute, lates);
      return this.toDto(saved);
    });
  }

  private toDto(setting: {
    lateAfterHour: number;
    lateAfterMinute: number;
    latesPerDeductedDay?: number;
    updatedAt: Date | null;
  }): AttendanceSettingDto {
    return {
      lateAfterHour: setting.lateAfterHour,
      lateAfterMinute: setting.lateAfterMinute,
      lateAfter: formatLateAfter(setting.lateAfterHour, setting.lateAfterMinute),
      latesPerDeductedDay: setting.latesPerDeductedDay ?? DEFAULT_THRESHOLD.latesPerDeductedDay,
      updatedAt: setting.updatedAt,
    };
  }
}

/** An integer >= 1. Zero would divide by zero in `penaltyDays`; a fraction is meaningless. */
function normalizeLatesPerDay(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw badRequest('latesPerDeductedDay must be an integer greater than or equal to 1');
  }
  return n;
}
