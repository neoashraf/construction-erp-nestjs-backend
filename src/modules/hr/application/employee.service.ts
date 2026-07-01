/**
 * EmployeeService — the office-staff master use cases (FR-HR-001/-002/-003). CRUD + reassign (append-only
 * history) + deactivate/reactivate, each inside the caller's UoW with an audit row committed atomically.
 * Office-staff-only policy is enforced at create (a daily-labour/subcontractor wage-type marker is
 * rejected — FR-HR-001, edge §12.14); the company-unique employee_code is guarded here (the DB unique
 * index is the backstop); reassign() appends an EmployeeAssignment and never overwrites a prior one. No
 * ledger impact anywhere in this service.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DuplicateCodeError, NotFoundError } from '../../../common/errors/domain-error';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { UNIT_OF_WORK, UnitOfWork } from '../../../common/ports/unit-of-work.port';
import { Actor } from '../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService } from '../../../core/audit/application/audit.port';
import {
  EMPLOYEE_SOURCE_TYPE,
  Employee,
  EmployeeAssignment,
  EditEmployee,
  NewEmployee,
} from '../domain/employee';
import { NotOfficeStaffError } from '../domain/errors';
import { EMPLOYEE_REPOSITORY, EmployeeRepository } from '../domain/ports/employee.repository';

export interface ReassignInput {
  projectId: string;
  effectiveDate: string;
  note?: string | null;
}

@Injectable()
export class EmployeeService {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY) private readonly repo: EmployeeRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async create(input: NewEmployee, actor: Actor): Promise<{ id: string }> {
    return this.uow.run(async () => {
      // Office-staff-only policy: reject anything but MONTHLY/DAILY office wage types (a caller trying to
      // register a daily labourer / subcontractor worker as an Employee — FR-HR-001, edge §12.14).
      if (input.wageType !== 'MONTHLY' && input.wageType !== 'DAILY') {
        throw new NotOfficeStaffError('wageType must be MONTHLY or DAILY office staff');
      }
      if (await this.repo.existsCode(actor.companyId, input.employeeCode)) {
        throw new DuplicateCodeError(input.employeeCode, { field: 'employeeCode' });
      }
      const employee = Employee.create(this.ids.next(), actor.companyId, input);
      await this.repo.insert(employee);
      // Seed the assignment history with the default project (if any), so reassignment history is complete.
      if (employee.props.defaultProjectId) {
        await this.repo.appendAssignment(
          EmployeeAssignment.create(this.ids.next(), {
            employeeId: employee.id,
            companyId: actor.companyId,
            projectId: employee.props.defaultProjectId,
            effectiveDate: employee.props.joiningDate,
            note: 'Initial assignment',
          }),
        );
      }
      await this.audit.record({
        action: 'CREATE',
        entityType: EMPLOYEE_SOURCE_TYPE,
        entityId: employee.id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
      return { id: employee.id };
    });
  }

  async update(id: string, patch: EditEmployee, version: number, actor: Actor): Promise<void> {
    return this.uow.run(async () => {
      const employee = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!employee) throw new NotFoundError(`Employee ${id} not found`);
      employee.update(patch);
      await this.repo.save(employee, version);
      await this.audit.record({
        action: 'UPDATE',
        entityType: EMPLOYEE_SOURCE_TYPE,
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }

  async reassign(id: string, input: ReassignInput, version: number, actor: Actor): Promise<void> {
    return this.uow.run(async () => {
      const employee = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!employee) throw new NotFoundError(`Employee ${id} not found`);
      const assignment = employee.reassign(
        this.ids.next(),
        input.projectId,
        input.effectiveDate,
        input.note ?? null,
      );
      await this.repo.save(employee, version);
      await this.repo.appendAssignment(assignment); // append-only — never overwrites a prior row (FR-HR-002)
      await this.audit.record({
        action: 'UPDATE',
        entityType: EMPLOYEE_SOURCE_TYPE,
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }

  async deactivate(id: string, version: number, actor: Actor): Promise<void> {
    return this.setStatus(id, version, actor, 'deactivate');
  }

  async reactivate(id: string, version: number, actor: Actor): Promise<void> {
    return this.setStatus(id, version, actor, 'reactivate');
  }

  private async setStatus(
    id: string,
    version: number,
    actor: Actor,
    action: 'deactivate' | 'reactivate',
  ): Promise<void> {
    return this.uow.run(async () => {
      const employee = await this.repo.findByIdForUpdate(id, actor.companyId);
      if (!employee) throw new NotFoundError(`Employee ${id} not found`);
      if (action === 'deactivate') employee.deactivate();
      else employee.reactivate();
      await this.repo.save(employee, version);
      await this.audit.record({
        action: action === 'deactivate' ? 'DEACTIVATE' : 'REACTIVATE',
        entityType: EMPLOYEE_SOURCE_TYPE,
        entityId: id,
        actorId: actor.userId,
        companyId: actor.companyId,
      });
    });
  }
}
