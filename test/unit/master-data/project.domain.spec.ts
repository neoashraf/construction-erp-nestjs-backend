/**
 * Project domain unit tests (no DB) — the status state machine (FR-MAS-006, design §3.1) + the
 * create date guard.
 */
import { Project } from '../../../src/modules/master-data/project/domain/project';
import { InvalidStatusTransitionError, ValidationError } from '../../../src/common/errors/domain-error';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';
import { Clock } from '../../../src/common/ports/clock.port';

const ids: IdGenerator = { next: () => 'proj-1' };
const clock: Clock = { now: () => new Date('2026-07-15T10:00:00Z') };
const BASE = {
  companyId: 'co-1',
  projectCode: 'P-01',
  name: 'Tower A',
  customerId: 'cust-1',
  projectManagerId: 'pm-1',
  startDate: '2025-01-01',
  expectedEndDate: '2026-01-01',
};

describe('Project (domain)', () => {
  it('creates PLANNED at version 1 and rejects bad dates', () => {
    const p = Project.create(BASE, ids);
    expect(p.props.status).toBe('PLANNED');
    expect(p.version).toBe(1);
    expect(() => Project.create({ ...BASE, expectedEndDate: '2024-01-01' }, ids)).toThrow(ValidationError);
  });

  it('walks the FSM: activate → hold → resume → close → reopen', () => {
    const p = Project.create(BASE, ids);
    p.changeStatus('activate', clock);
    expect(p.props.status).toBe('ACTIVE');
    p.changeStatus('hold', clock);
    expect(p.props.status).toBe('ON_HOLD');
    p.changeStatus('resume', clock);
    expect(p.props.status).toBe('ACTIVE');
    p.changeStatus('close', clock);
    expect(p.props.status).toBe('CLOSED');
    expect(p.props.actualEndDate?.value).toBe('2026-07-15');
    p.changeStatus('reopen', clock);
    expect(p.props.status).toBe('ACTIVE');
    expect(p.props.actualEndDate).toBeNull();
  });

  it('rejects illegal transitions', () => {
    const p = Project.create(BASE, ids); // PLANNED
    expect(() => p.changeStatus('hold', clock)).toThrow(InvalidStatusTransitionError); // can't hold from PLANNED
    expect(() => p.changeStatus('close', clock)).toThrow(InvalidStatusTransitionError); // can't close from PLANNED
  });
});
