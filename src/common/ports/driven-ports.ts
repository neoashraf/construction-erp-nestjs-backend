/**
 * Other driven ports listed in ADR-0002 §2.1. Declared here so the domain/application can depend on
 * the interfaces from day one; infrastructure adapters are supplied by the briefs that need them
 * (SMS in HR/notifications, exports in RPT, events as modules start publishing). PURE interfaces.
 */

/** SMS is a primary channel in Bangladesh (CLAUDE.md). Implemented by an infra adapter later. */
export interface SmsSender {
  send(to: string, message: string): Promise<void>;
}
export const SMS_SENDER = Symbol('SmsSender');

/** Report/export sink — Excel/PDF generation lives behind this (RPT brief). */
export interface FileExporter {
  toExcel(rows: ReadonlyArray<Record<string, unknown>>, sheetName?: string): Promise<Buffer>;
  toPdf(document: unknown): Promise<Buffer>;
}
export const FILE_EXPORTER = Symbol('FileExporter');

/** Publishes domain events drained from aggregates after a successful commit. */
import { DomainEvent } from '../domain/domain';
export interface EventPublisher {
  publish(events: ReadonlyArray<DomainEvent>): Promise<void>;
}
export const EVENT_PUBLISHER = Symbol('EventPublisher');
