/**
 * NotificationService.emit unit tests (NTF, FR-NTF-016..021, 002/010/011/012). Fakes for the repo,
 * resolver, pusher, ids — asserts resolve→union→dedupe→persist→best-effort push orchestration.
 */
import { NotFoundException } from '@nestjs/common';
import { NotificationService } from '../../../src/core/notifications/application/notification.service';
import { RecipientRule } from '../../../src/core/notifications/domain/notification-catalog';
import { NotificationRecord, EmitCommand } from '../../../src/core/notifications/domain/notification-record';
import { RecipientContext } from '../../../src/core/notifications/domain/ports/recipient-resolver.port';
import { Actor } from '../../../src/core/tenancy/tenant-context';

const CO = 'co-1';

class FakeRepo {
  rows: NotificationRecord[] = [];
  read = new Set<string>();
  insertIfAbsent = async (r: NotificationRecord) => {
    if (this.rows.some(x => x.recipientUserId === r.recipientUserId && x.eventKey === r.eventKey)) return false;
    this.rows.push(r);
    return true;
  };
  markOneRead = async (id: string, recipient: string) => {
    const r = this.rows.find(x => x.id === id && x.recipientUserId === recipient);
    if (!r) return null;
    this.read.add(id);
    return new Date('2026-07-05T00:00:00Z');
  };
  markAllRead = async (recipient: string) => {
    const n = this.rows.filter(x => x.recipientUserId === recipient && !this.read.has(x.id)).length;
    this.rows.forEach(x => { if (x.recipientUserId === recipient) this.read.add(x.id); });
    return n;
  };
  unreadCount = async (_c: string, recipient: string) =>
    this.rows.filter(x => x.recipientUserId === recipient && !this.read.has(x.id)).length;
}

class FakePusher {
  news: { userId: string; companyId: string }[] = [];
  counts: { userId: string; unreadCount: number }[] = [];
  failNew = false;
  pushNew = async (userId: string, companyId: string) => {
    if (this.failNew) throw new Error('socket down');
    this.news.push({ userId, companyId });
  };
  pushUnreadCount = async (userId: string, _c: string, unreadCount: number) => { this.counts.push({ userId, unreadCount }); };
}

/** Resolver returns a preset id list per rule kind + roles, honouring the project context for PROJECT_ROLE. */
function fakeResolver(map: { role?: string[]; projectRole?: string[]; user?: string[] }) {
  return {
    resolve: async (rule: RecipientRule, ctx: RecipientContext): Promise<string[]> => {
      if (rule.kind === 'USER') return ctx.affectedUserId ? (map.user ?? [ctx.affectedUserId]) : [];
      if (rule.kind === 'ROLE') return map.role ?? [];
      return ctx.projectId ? (map.projectRole ?? []) : [];
    },
  } as any;
}

let idc = 0;
const fakeIds = { next: () => `n-${++idc}` } as any;

function build(repo: FakeRepo, resolver: any, pusher: FakePusher) {
  idc = 0;
  return new NotificationService(repo as any, resolver, pusher as any, fakeIds);
}

const baseCmd = (over?: Partial<EmitCommand>): EmitCommand => ({
  type: 'REQ_SUBMITTED', companyId: CO, title: 'Requisition awaiting approval', body: 'x',
  projectId: 'proj-1', eventKey: 'req-1', ...over,
});

function actor(userId: string): Actor {
  return { userId, companyId: CO, financialYearId: 'fy', role: 'X', isUnscoped: false, assignedProjectIds: [], approvalLimit: null };
}

describe('NotificationService.emit', () => {
  it('rejects an unknown notification type', async () => {
    const repo = new FakeRepo();
    await expect(build(repo, fakeResolver({}), new FakePusher()).emit(baseCmd({ type: 'NOPE' })))
      .rejects.toThrow(/UNKNOWN_NOTIFICATION_TYPE/);
  });

  it('resolves the union of rules and dedupes a recipient shared across rules', async () => {
    // REQ_SUBMITTED = PROJECT_ROLE(PM) + ROLE(AM); make 'u1' appear in both → one row.
    const repo = new FakeRepo();
    const pusher = new FakePusher();
    const res = await build(repo, fakeResolver({ projectRole: ['u1'], role: ['u1', 'u2'] }), pusher).emit(baseCmd());
    expect(res.created).toBe(2); // u1 (once) + u2
    expect(new Set(repo.rows.map(r => r.recipientUserId))).toEqual(new Set(['u1', 'u2']));
    expect(pusher.news).toHaveLength(2); // pushNew per created recipient (FR-NTF-010)
  });

  it('is idempotent on (recipient, eventKey): a re-emit creates nothing and pushes nothing', async () => {
    const repo = new FakeRepo();
    const pusher = new FakePusher();
    const svc = build(repo, fakeResolver({ projectRole: ['u1'], role: ['u2'] }), pusher);
    const first = await svc.emit(baseCmd());
    expect(first.created).toBe(2);
    const again = await svc.emit(baseCmd()); // same eventKey
    expect(again.created).toBe(0);
    expect(repo.rows).toHaveLength(2);
    expect(pusher.news).toHaveLength(2); // no extra push on the duplicate
  });

  it('carries the catalogue severity + source module onto each row', async () => {
    const repo = new FakeRepo();
    await build(repo, fakeResolver({ role: ['u1'] }), new FakePusher()).emit(baseCmd());
    expect(repo.rows[0].severity).toBe('HIGH');
    expect(repo.rows[0].sourceModule).toBe('REQ');
    expect(repo.rows[0].type).toBe('REQ_SUBMITTED');
  });

  it('a push failure is swallowed — the rows still persist (best-effort, FR-NTF-011/012)', async () => {
    const repo = new FakeRepo();
    const pusher = new FakePusher(); pusher.failNew = true;
    const res = await build(repo, fakeResolver({ role: ['u1', 'u2'] }), pusher).emit(baseCmd());
    expect(res.created).toBe(2); // never throws
    expect(repo.rows).toHaveLength(2); // authoritative feed intact
  });

  it('markOneRead: 404 when not the caller’s; returns readAt + pushes count when owned', async () => {
    const repo = new FakeRepo();
    const pusher = new FakePusher();
    const svc = build(repo, fakeResolver({ role: ['u1'] }), pusher);
    await svc.emit(baseCmd());
    const id = repo.rows[0].id;
    await expect(svc.markOneRead(actor('someone-else'), id)).rejects.toBeInstanceOf(NotFoundException);
    const out = await svc.markOneRead(actor('u1'), id);
    expect(out).toMatchObject({ id, isRead: true });
    expect(pusher.counts.at(-1)).toMatchObject({ userId: 'u1', unreadCount: 0 });
  });

  it('markAllRead: returns the updated count and pushes the new (zero) count', async () => {
    const repo = new FakeRepo();
    const pusher = new FakePusher();
    const svc = build(repo, fakeResolver({ role: ['u1'] }), pusher);
    await svc.emit(baseCmd());
    await svc.emit(baseCmd({ eventKey: 'req-2' }));
    const out = await svc.markAllRead(actor('u1'));
    expect(out.updated).toBe(2);
    expect(pusher.counts.at(-1)).toMatchObject({ userId: 'u1', unreadCount: 0 });
  });
});
