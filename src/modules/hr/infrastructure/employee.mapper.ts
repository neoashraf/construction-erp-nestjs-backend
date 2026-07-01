/**
 * EmployeeMapper (INFRASTRUCTURE) — Employee/EmployeeAssignment aggregate ↔ ORM rows. The domain never
 * imports TypeORM; this is the only seam. Money ↔ Decimal is exact via the ORM transformer.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../common/money';
import {
  Employee,
  EmployeeAssignment,
  EmployeeStatus,
  WageType,
  WorkBase,
} from '../domain/employee';
import { EmployeeAssignmentOrmEntity } from './employee-assignment.orm-entity';
import { EmployeeOrmEntity } from './employee.orm-entity';

export const EmployeeMapper = {
  toOrm(e: Employee): EmployeeOrmEntity {
    const p = e.props;
    const row = new EmployeeOrmEntity();
    row.id = e.id;
    row.companyId = p.companyId;
    row.employeeCode = p.employeeCode;
    row.name = p.name;
    row.designation = p.designation;
    row.defaultProjectId = p.defaultProjectId;
    row.department = p.department;
    row.workBase = p.workBase;
    row.wageType = p.wageType;
    row.wageAmount = p.wageAmount.amount;
    row.bankAccountName = p.bankAccountName;
    row.bankAccountNo = p.bankAccountNo;
    row.bankName = p.bankName;
    row.pfApplicable = p.pfApplicable;
    row.gratuityApplicable = p.gratuityApplicable;
    row.wppfApplicable = p.wppfApplicable;
    row.tin = p.tin;
    row.joiningDate = p.joiningDate;
    row.status = p.status;
    row.deletedAt = null;
    return row;
  },

  toDomain(r: EmployeeOrmEntity): Employee {
    return Employee.rehydrate(r.id, {
      companyId: r.companyId,
      employeeCode: r.employeeCode,
      name: r.name,
      designation: r.designation,
      defaultProjectId: r.defaultProjectId,
      department: r.department,
      workBase: r.workBase as WorkBase,
      wageType: r.wageType as WageType,
      wageAmount: Money.of(new Decimal(r.wageAmount)),
      bankAccountName: r.bankAccountName,
      bankAccountNo: r.bankAccountNo,
      bankName: r.bankName,
      pfApplicable: r.pfApplicable,
      gratuityApplicable: r.gratuityApplicable,
      wppfApplicable: r.wppfApplicable,
      tin: r.tin,
      joiningDate: r.joiningDate,
      status: r.status as EmployeeStatus,
      version: r.version,
    });
  },

  assignmentToOrm(a: EmployeeAssignment): EmployeeAssignmentOrmEntity {
    const p = a.props;
    const row = new EmployeeAssignmentOrmEntity();
    row.id = a.id;
    row.employeeId = p.employeeId;
    row.companyId = p.companyId;
    row.projectId = p.projectId;
    row.effectiveDate = p.effectiveDate;
    row.note = p.note;
    return row;
  },

  assignmentToDomain(r: EmployeeAssignmentOrmEntity): EmployeeAssignment {
    return EmployeeAssignment.rehydrate(r.id, {
      employeeId: r.employeeId,
      companyId: r.companyId,
      projectId: r.projectId,
      effectiveDate: r.effectiveDate,
      note: r.note,
    });
  },
};
