/**
 * Posting kernel module (LED) — EMPTY-BUT-WIRED.
 *
 * The ledger spine lands here in the `ledger-posting-core` brief: the `JournalEntry` aggregate +
 * `journal_entry`/`journal_line` schema with the deferred-balance + append-only triggers, and the
 * single `PostingService` — the ONLY writer to the ledger. No business logic ships in the scaffold.
 * `domain/ application/ infrastructure/ presentation/` folders are present so that brief drops in
 * without restructuring. `core/*` imports nothing from `modules/*`.
 */
import { Module } from '@nestjs/common';

@Module({})
export class PostingModule {}
