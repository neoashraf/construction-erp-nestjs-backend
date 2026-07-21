/**
 * ProjectManagerAssignmentService unit tests (MAS, FR-MAS-005 × FR-AUD-014/031). No DB —
 * fakes for the user_project / user / role repos, AuditService, IdGenerator, Clock. Asserts:
 * a scoped PM gets a user_project row + audit; unscoped/unknown/cross-company/already-assigned
 * are no-ops.
 */
import { ProjectManagerAssignmentService } from '../../../src/modules/master-data/project/application/project-manager-assignment.service';
import { UserProjectAssignment } from '../../../src/core/auth/domain/user-project-assignment.entity';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const CO = 'co-1';
const PM_USER = 'pm-user-1';
const PROJECT = 'project-1';

function actor(): Actor {
  return { userId: 'admin-1', companyId: CO, financialYearId: 'fy-1', role: 'ADMIN', isUnscoped: true, assignedProjectIds: [], approvalLimit: null };
}

class FakeAssignments {
  rows: UserProjectAssignment[] = [];
  findByUserAndProject = async (userId: string, projectId: string) =>
    this.rows.find((a) => a.props.userId === userId && a.props.projectId === projectId) ?? null;
  save = async (a: UserProjectAssignment) => { this.rows.push(a); };
  // unused by the service
  findByUserId = async () => [];
  replaceSet = async () => ({ added: [], removed: [] });
  unassign = async () => {};
}

/** A minimal user/role stand-in — the service only reads `.props`. */
function fakeUsers(user: { companyId: string; role: string } | null) {
  return { findById: async () => (user ? { props: user } : null) } as any;
}
function fakeRoles(isUnscoped: boolean) {
  return { findByName: async () => ({ props: { isUnscoped } }) } as any;
}

class FakeAudit { entries: any[] = []; record = async (e: any) => { this.entries.push(e); }; }
const ids = { next: () => 'assign-1' };
const clock = { now: () => new Date('2026-07-21T00:00:00.000Z') };

function make(opts: {
  user?: { companyId: string; role: string } | null;
  isUnscoped?: boolean;
  seeded?: boolean;
}) {
  const assignments = new FakeAssignments();
  if (opts.seeded) {
    assignments.rows.push(
      UserProjectAssignment.create('pre-1', { userId: PM_USER, projectId: PROJECT, companyId: CO, assignedAt: new Date() }),
    );
  }
  const audit = new FakeAudit();
  const user = opts.user === undefined ? { companyId: CO, role: 'PROJECT_MANAGER' } : opts.user;
  const svc = new ProjectManagerAssignmentService(
    assignments as any,
    fakeUsers(user),
    fakeRoles(opts.isUnscoped ?? false),
    audit as any,
    ids as any,
    clock as any,
  );
  return { svc, assignments, audit };
}

describe('ProjectManagerAssignmentService', () => {
  it('assigns a scoped PM to the project and audits it', async () => {
    const { svc, assignments, audit } = make({});
    await svc.ensureAssigned(PM_USER, PROJECT, actor());

    expect(assignments.rows).toHaveLength(1);
    expect(assignments.rows[0].props).toMatchObject({ userId: PM_USER, projectId: PROJECT, companyId: CO });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: 'CREATE', entityType: 'UserProjectAssignment', entityId: `${PM_USER}:${PROJECT}` });
  });

  it('is a no-op for an unscoped role (they already see every project)', async () => {
    const { svc, assignments, audit } = make({ isUnscoped: true });
    await svc.ensureAssigned(PM_USER, PROJECT, actor());
    expect(assignments.rows).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('is a no-op when the PM id resolves to no company user', async () => {
    const { svc, assignments } = make({ user: null });
    await svc.ensureAssigned(PM_USER, PROJECT, actor());
    expect(assignments.rows).toHaveLength(0);
  });

  it('is a no-op for a user of another company', async () => {
    const { svc, assignments } = make({ user: { companyId: 'other-co', role: 'PROJECT_MANAGER' } });
    await svc.ensureAssigned(PM_USER, PROJECT, actor());
    expect(assignments.rows).toHaveLength(0);
  });

  it('does not duplicate an existing assignment', async () => {
    const { svc, assignments, audit } = make({ seeded: true });
    await svc.ensureAssigned(PM_USER, PROJECT, actor());
    expect(assignments.rows).toHaveLength(1); // the pre-seeded row, untouched
    expect(audit.entries).toHaveLength(0);
  });
});
