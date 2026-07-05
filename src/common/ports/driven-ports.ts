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

/** Subscribe side of the same in-process bus — a consumer (e.g. NTF) registers a best-effort handler. */
export type EventHandler = (event: DomainEvent) => Promise<void> | void;
export interface EventSubscriber {
  subscribe(handler: EventHandler): void;
}
export const EVENT_SUBSCRIBER = Symbol('EventSubscriber');

/**
 * Image/media store — the profile avatar is offloaded here (Cloudinary adapter, AUD profile slice /
 * FR-AUD-038..043). The domain/application depend only on this interface; the vendor SDK lives in an
 * infrastructure adapter. The DB keeps only the returned `url` + `publicId`, never the binary.
 */
export interface MediaUploadInput {
  /** The raw image bytes. */
  readonly buffer: Buffer;
  /** MIME type, already validated by the caller (image/jpeg|png|webp). */
  readonly mimeType: string;
  /** Destination folder/namespace (company-scoped, e.g. `companies/<id>/avatars`). */
  readonly folder: string;
  /** Stable asset id within the folder (e.g. `user_<id>`), so a replace overwrites deterministically. */
  readonly publicId?: string;
}
export interface MediaUploadResult {
  /** The served CDN URL persisted as `avatar_url` and returned to clients. */
  readonly url: string;
  /** The vendor asset handle persisted as `avatar_public_id` (never returned to clients). */
  readonly publicId: string;
}
export interface MediaStorage {
  upload(input: MediaUploadInput): Promise<MediaUploadResult>;
  delete(publicId: string): Promise<void>;
}
export const MEDIA_STORAGE = Symbol('MediaStorage');
