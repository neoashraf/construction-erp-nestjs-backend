/**
 * Project master (MAS, FR-MAS-005/006) — PURE domain. Lean entity + the status state machine
 * (design §3.1): PLANNED→ACTIVE (activate), ACTIVE↔ON_HOLD (hold/resume), ACTIVE|ON_HOLD→CLOSED
 * (close, stamps actualEndDate), CLOSED→ACTIVE (reopen, clears it). Illegal moves throw.
 */
import { Entity } from '../../../../common/domain/domain';
import { InvalidStatusTransitionError, ValidationError } from '../../../../common/errors/domain-error';
import { DateOnly } from '../../../../common/value-objects/date-only';
import { Clock } from '../../../../common/ports/clock.port';
import { IdGenerator } from '../../../../common/ports/id-generator.port';

export type ProjectStatus = 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'CLOSED';
export type ProjectStatusAction = 'activate' | 'hold' | 'resume' | 'close' | 'reopen';

export interface ProjectProps {
  companyId: string;
  projectCode: string;
  name: string;
  location: string | null;
  customerId: string;
  projectManagerId: string;
  startDate: DateOnly;
  expectedEndDate: DateOnly;
  actualEndDate: DateOnly | null;
  status: ProjectStatus;
  version: number;
}

export class Project extends Entity<string> {
  private constructor(
    id: string,
    private _props: ProjectProps,
  ) {
    super(id);
  }

  static create(
    input: {
      companyId: string;
      projectCode: string;
      name: string;
      location?: string | null;
      customerId: string;
      projectManagerId: string;
      startDate: string;
      expectedEndDate: string;
    },
    ids: IdGenerator,
  ): Project {
    const startDate = DateOnly.of(input.startDate);
    const expectedEndDate = DateOnly.of(input.expectedEndDate);
    if (!expectedEndDate.isAfter(startDate)) {
      throw new ValidationError('expected_end_date must be after start_date', {
        startDate: startDate.value,
        expectedEndDate: expectedEndDate.value,
      });
    }
    return new Project(ids.next(), {
      companyId: input.companyId,
      projectCode: Project.req(input.projectCode, 'project_code'),
      name: Project.req(input.name, 'name'),
      location: Project.opt(input.location),
      customerId: input.customerId,
      projectManagerId: input.projectManagerId,
      startDate,
      expectedEndDate,
      actualEndDate: null,
      status: 'PLANNED',
      version: 1,
    });
  }

  static rehydrate(id: string, props: ProjectProps): Project {
    return new Project(id, props);
  }

  /** Patch descriptive fields. project_code is handled by the use case (immutable-once-referenced). */
  update(input: {
    name?: string;
    location?: string | null;
    customerId?: string;
    projectManagerId?: string;
    expectedEndDate?: string;
    projectCode?: string;
  }): void {
    if (input.name !== undefined) this._props.name = Project.req(input.name, 'name');
    if (input.location !== undefined) this._props.location = Project.opt(input.location);
    if (input.customerId !== undefined) this._props.customerId = input.customerId;
    if (input.projectManagerId !== undefined) this._props.projectManagerId = input.projectManagerId;
    if (input.projectCode !== undefined) this._props.projectCode = Project.req(input.projectCode, 'project_code');
    if (input.expectedEndDate !== undefined) {
      const eed = DateOnly.of(input.expectedEndDate);
      if (!eed.isAfter(this._props.startDate)) {
        throw new ValidationError('expected_end_date must be after start_date');
      }
      this._props.expectedEndDate = eed;
    }
  }

  changeStatus(action: ProjectStatusAction, clock: Clock): void {
    const s = this._props.status;
    const ok =
      (action === 'activate' && s === 'PLANNED') ||
      (action === 'hold' && s === 'ACTIVE') ||
      (action === 'resume' && s === 'ON_HOLD') ||
      (action === 'close' && (s === 'ACTIVE' || s === 'ON_HOLD')) ||
      (action === 'reopen' && s === 'CLOSED');
    if (!ok) throw new InvalidStatusTransitionError(s, action);
    if (action === 'activate' || action === 'resume' || action === 'reopen') {
      this._props.status = 'ACTIVE';
      if (action === 'reopen') this._props.actualEndDate = null;
    } else if (action === 'hold') {
      this._props.status = 'ON_HOLD';
    } else if (action === 'close') {
      this._props.status = 'CLOSED';
      this._props.actualEndDate = DateOnly.fromDate(clock.now());
    }
  }

  isClosed(): boolean {
    return this._props.status === 'CLOSED';
  }

  get props(): Readonly<ProjectProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }

  private static req(v: string, field: string): string {
    const t = (v ?? '').trim();
    if (!t) throw new ValidationError(`${field} is required`, { field });
    return t;
  }
  private static opt(v: string | null | undefined): string | null {
    if (v == null) return null;
    const t = v.trim();
    return t ? t : null;
  }
}
