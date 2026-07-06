/**
 * InProcessEventBus unit tests (#41) — fan-out to subscribers + best-effort isolation.
 */
import { InProcessEventBus } from '../../../src/infrastructure/events/in-process-event-bus';
import { DomainEvent } from '../../../src/common/domain/domain';

const evt = (name: string): DomainEvent => ({ name, occurredAt: new Date('2026-07-05T00:00:00Z') });

describe('InProcessEventBus', () => {
  it('publishes each event to every subscriber', async () => {
    const bus = new InProcessEventBus();
    const a: string[] = []; const b: string[] = [];
    bus.subscribe(e => { a.push(e.name); });
    bus.subscribe(e => { b.push(e.name); });
    await bus.publish([evt('X'), evt('Y')]);
    expect(a).toEqual(['X', 'Y']);
    expect(b).toEqual(['X', 'Y']);
  });

  it('isolates a throwing subscriber — publish still resolves and other subscribers still run', async () => {
    const bus = new InProcessEventBus();
    const ok: string[] = [];
    bus.subscribe(() => { throw new Error('handler boom'); });
    bus.subscribe(e => { ok.push(e.name); });
    await expect(bus.publish([evt('Z')])).resolves.toBeUndefined();
    expect(ok).toEqual(['Z']); // the healthy subscriber still received it
  });
});
