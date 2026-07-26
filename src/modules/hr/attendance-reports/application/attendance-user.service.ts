/**
 * AttendanceUserService — the device→employee registry behind `/api/attendance/users`
 * (SUPPORTING_APIS_GUIDE §7). A fingerprint device only ever sends a numeric `userId`; it knows no names.
 * This is the mapping that turns that number into a person, and it is what every report row is built
 * from — an employee absent from here simply never appears in a report, punches or not.
 *
 * ⚠️ PATH: the guide mounts this at `/api/users`, which in THIS system is auth user management (login
 * accounts, roles). It is mounted at `/api/attendance/users` instead, and it reads/writes the existing
 * `employee` table rather than a parallel one — the reports already read `employee`, so there is still
 * exactly one employee registry (CLAUDE.md "one owner per entity"). `userId` maps to `employee_code`.
 *
 * ⚠️ DEFAULTS ON CREATE: `employee` requires designation / work_base / wage_type / joining_date, none of
 * which this minimal payload carries. A row created here gets documented placeholders (see
 * `CREATE_DEFAULTS`) so a device enrolment is never blocked — but the employee is NOT payroll-ready
 * until someone completes it via `/api/hr/employees`. Full employee CRUD stays there; this endpoint is
 * deliberately just the device mapping.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { badRequest } from '../domain/attendance-rules';
import {
  ATTENDANCE_USER_REPOSITORY,
  AttendanceUserDto,
  AttendanceUserRepository,
} from '../domain/ports/attendance-user.repository';

/** Placeholders for the NOT NULL columns a device enrolment cannot supply. */
export const CREATE_DEFAULTS = {
  designation: 'Unassigned',
  workBase: 'SITE',
  wageType: 'MONTHLY',
} as const;

@Injectable()
export class AttendanceUserService {
  constructor(
    @Inject(ATTENDANCE_USER_REPOSITORY) private readonly repo: AttendanceUserRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  list(actor: Actor): Promise<AttendanceUserDto[]> {
    return this.repo.list(actor.companyId);
  }

  /**
   * Upsert by `userId` — posting the same id twice updates rather than 409s, because a device enrolment
   * is naturally replayed. `designation` is written ONLY when the caller supplies it, so a partial update
   * cannot silently wipe an existing job title; pass an explicit `null` to clear it.
   */
  async upsert(
    input: { userId?: unknown; name?: unknown; designation?: unknown },
    actor: Actor,
  ): Promise<AttendanceUserDto> {
    const userId = String(input.userId ?? '').trim();
    if (!userId) throw badRequest('userId is required');

    const name = String(input.name ?? '').trim();
    if (!name) throw badRequest('name is required');

    let designation: string | null | undefined;
    if (input.designation !== undefined) {
      if (input.designation !== null && typeof input.designation !== 'string') {
        throw badRequest('designation must be a string or null');
      }
      designation = input.designation === null ? null : String(input.designation).trim() || null;
    }

    return this.uow.run(() =>
      this.repo.upsert(actor.companyId, { userId, name, designation }, CREATE_DEFAULTS),
    );
  }
}
