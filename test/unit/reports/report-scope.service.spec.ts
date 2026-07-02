/**
 * ReportScopeService resolution (RPT · FR-RPT-006/-007 — AUD F3/F4; SRS edge cases 1, 2). On fake actors:
 * an unscoped user passes all projects; a PM with no projectId is auto-filtered to assignedProjectIds; a
 * PM with an explicit unassigned projectId is 403; a PM with no assignments gets an empty scope (a valid
 * empty report, not all projects).
 */
import { ForbiddenException } from '@nestjs/common';
import { ReportScopeService } from '../../../src/reports/application/report-scope.service';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const CO = 'company-1';
const base: Actor = {
  userId: 'u1', companyId: CO, financialYearId: 'fy1', role: 'X',
  isUnscoped: false, assignedProjectIds: [], approvalLimit: null,
};
const admin: Actor = { ...base, role: 'ADMIN', isUnscoped: true };
const pmAB: Actor = { ...base, role: 'PROJECT_MANAGER', assignedProjectIds: ['A', 'B'] };
const pmNone: Actor = { ...base, role: 'PROJECT_MANAGER', assignedProjectIds: [] };

describe('ReportScopeService.resolve', () => {
  const svc = new ReportScopeService();

  it('unscoped user, no projectId → all projects (null)', () => {
    expect(svc.resolve(admin)).toEqual({ companyId: CO, projectIds: null });
  });

  it('unscoped user, explicit projectId → that project', () => {
    expect(svc.resolve(admin, 'Z')).toEqual({ companyId: CO, projectIds: ['Z'] });
  });

  it('PM, no projectId → auto-filtered to assigned projects', () => {
    expect(svc.resolve(pmAB)).toEqual({ companyId: CO, projectIds: ['A', 'B'] });
  });

  it('PM, explicit assigned projectId → that project', () => {
    expect(svc.resolve(pmAB, 'A')).toEqual({ companyId: CO, projectIds: ['A'] });
  });

  it('PM, explicit UNASSIGNED projectId → 403 (not empty)', () => {
    expect(() => svc.resolve(pmAB, 'C')).toThrow(ForbiddenException);
  });

  it('PM with no assignments → empty scope ([]) = valid empty report', () => {
    expect(svc.resolve(pmNone)).toEqual({ companyId: CO, projectIds: [] });
  });
});
