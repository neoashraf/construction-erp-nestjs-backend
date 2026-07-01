/**
 * TypeOrmEmployeeRepository (INFRASTRUCTURE) — persists the Employee aggregate + its append-only
 * assignment history. Enrols in the active UnitOfWork via getManager. Every method is companyId-scoped
 * (F3). `findByIdForUpdate` takes a pessimistic row lock inside a mutating UoW; `save` bumps `version`
 * under the optimistic-lock check. `appendAssignment` INSERTs a history row — never UPDATE/DELETE (FR-HR-002).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Employee, EmployeeAssignment } from '../domain/employee';
import { EmployeeRepository } from '../domain/ports/employee.repository';
import { EmployeeMapper } from './employee.mapper';
import { EmployeeOrmEntity } from './employee.orm-entity';
import { EmployeeAssignmentOrmEntity } from './employee-assignment.orm-entity';

@Injectable()
export class TypeOrmEmployeeRepository implements EmployeeRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(employee: Employee): Promise<void> {
    const row = EmployeeMapper.toOrm(employee);
    row.version = 1;
    await getManager(this.dataSource).getRepository(EmployeeOrmEntity).insert(row);
  }

  async save(employee: Employee, expectedVersion: number): Promise<void> {
    const row = EmployeeMapper.toOrm(employee);
    const res = await getManager(this.dataSource)
      .getRepository(EmployeeOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        name: row.name,
        designation: row.designation,
        defaultProjectId: row.defaultProjectId,
        department: row.department,
        workBase: row.workBase,
        wageType: row.wageType,
        wageAmount: row.wageAmount,
        bankAccountName: row.bankAccountName,
        bankAccountNo: row.bankAccountNo,
        bankName: row.bankName,
        pfApplicable: row.pfApplicable,
        gratuityApplicable: row.gratuityApplicable,
        wppfApplicable: row.wppfApplicable,
        tin: row.tin,
        status: row.status,
        version: expectedVersion + 1,
      })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: row.id,
        companyId: row.companyId,
        version: expectedVersion,
      })
      .execute();
    if (!res.affected) {
      throw new OptimisticLockConflictError(`Employee ${row.id} was modified concurrently`, { id: row.id });
    }
  }

  async findById(id: string, companyId: string): Promise<Employee | null> {
    const row = await getManager(this.dataSource)
      .getRepository(EmployeeOrmEntity)
      .findOne({ where: { id, companyId, deletedAt: null } as never });
    return row ? EmployeeMapper.toDomain(row) : null;
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<Employee | null> {
    const row = await getManager(this.dataSource)
      .getRepository(EmployeeOrmEntity)
      .createQueryBuilder('e')
      .setLock('pessimistic_write')
      .where('e.id = :id AND e.company_id = :companyId AND e.deleted_at IS NULL', { id, companyId })
      .getOne();
    return row ? EmployeeMapper.toDomain(row) : null;
  }

  async existsCode(companyId: string, employeeCode: string): Promise<boolean> {
    const count = await getManager(this.dataSource)
      .getRepository(EmployeeOrmEntity)
      .count({ where: { companyId, employeeCode, deletedAt: null } as never });
    return count > 0;
  }

  async findByCode(companyId: string, employeeCode: string): Promise<Employee | null> {
    const row = await getManager(this.dataSource)
      .getRepository(EmployeeOrmEntity)
      .findOne({ where: { companyId, employeeCode, deletedAt: null } as never });
    return row ? EmployeeMapper.toDomain(row) : null;
  }

  async activeForCompany(companyId: string, projectId?: string): Promise<Employee[]> {
    const qb = getManager(this.dataSource)
      .getRepository(EmployeeOrmEntity)
      .createQueryBuilder('e')
      .where('e.company_id = :companyId AND e.deleted_at IS NULL AND e.status = :status', {
        companyId,
        status: 'ACTIVE',
      });
    if (projectId) qb.andWhere('e.default_project_id = :projectId', { projectId });
    const rows = await qb.orderBy('e.employee_code', 'ASC').getMany();
    return rows.map((r) => EmployeeMapper.toDomain(r));
  }

  async appendAssignment(assignment: EmployeeAssignment): Promise<void> {
    await getManager(this.dataSource)
      .getRepository(EmployeeAssignmentOrmEntity)
      .insert(EmployeeMapper.assignmentToOrm(assignment));
  }

  async listAssignments(employeeId: string, companyId: string): Promise<EmployeeAssignment[]> {
    const rows = await getManager(this.dataSource)
      .getRepository(EmployeeAssignmentOrmEntity)
      .find({
        where: { employeeId, companyId } as never,
        order: { effectiveDate: 'DESC', createdAt: 'DESC' },
      });
    return rows.map((r) => EmployeeMapper.assignmentToDomain(r));
  }
}
