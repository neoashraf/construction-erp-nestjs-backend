/**
 * InProcessEventBus (INFRASTRUCTURE) — the platform's in-process domain-event bus (ADR-0002 driven port;
 * SRS 18 §16 RESOLVED ingestion model). Producers call `publish(events)` AFTER their business commit;
 * consumers (e.g. NTF's NotificationSubscriber) `subscribe(handler)`. Dispatch is best-effort and
 * isolated: a throwing handler is logged and never breaks `publish` or the other handlers — so a
 * notification failure can never propagate back into the producer's business flow (FR-NTF-012).
 *
 * Bound to BOTH `EVENT_PUBLISHER` (producers) and `EVENT_SUBSCRIBER` (consumers) as the same instance.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DomainEvent } from '../../common/domain/domain';
import { EventPublisher, EventSubscriber, EventHandler } from '../../common/ports/driven-ports';

@Injectable()
export class InProcessEventBus implements EventPublisher, EventSubscriber {
  private readonly logger = new Logger(InProcessEventBus.name);
  private readonly handlers: EventHandler[] = [];

  subscribe(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  async publish(events: ReadonlyArray<DomainEvent>): Promise<void> {
    for (const event of events) {
      for (const handler of this.handlers) {
        try {
          await handler(event);
        } catch (err) {
          this.logger.warn(`event handler failed for '${event.name}': ${(err as Error).message}`);
        }
      }
    }
  }
}
