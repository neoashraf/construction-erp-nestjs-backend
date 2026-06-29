/**
 * Domain building blocks (ADR-0002 §2.1, skill §4) — PURE TypeScript.
 * No NestJS, no TypeORM, no decorators. The base types every aggregate/entity/VO extends.
 */

/** An entity has identity (`id`); equality is by id + type, not by attributes. */
export abstract class Entity<TId> {
  protected constructor(readonly id: TId) {}

  equals(other?: Entity<TId>): boolean {
    if (other == null) return false;
    if (this === other) return true;
    if (this.constructor !== other.constructor) return false;
    return this.id === other.id;
  }
}

/** Aggregate root — the consistency boundary; collects domain events to publish after commit. */
export abstract class AggregateRoot<TId> extends Entity<TId> {
  private _events: DomainEvent[] = [];

  protected raise(event: DomainEvent): void {
    this._events.push(event);
  }

  /** Drain pending events (called by the application layer after a successful save). */
  pullEvents(): DomainEvent[] {
    const events = this._events;
    this._events = [];
    return events;
  }
}

/** A value object has no identity; equality is by structural value. */
export abstract class ValueObject {
  abstract equals(other: this): boolean;
}

/** Something that happened in the domain, worth telling other parts of the system about. */
export interface DomainEvent {
  readonly name: string;
  readonly occurredAt: Date;
}
