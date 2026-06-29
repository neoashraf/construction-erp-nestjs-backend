/**
 * PostingService — the ONLY code that writes the ledger (CLAUDE.md #2, FR-LED-002). Runs INSIDE the
 * UnitOfWork the caller (a voucher use case) opened; it never opens its own transaction (FR-LED-016/017).
 *
 * Validation order (design §4 — fail fast, number LAST so a rejected command consumes no number, AC8):
 *   1. period open (PER)        2. project not closed (MAS)     3. tag matrix (§5.1)
 *   4. reference validity (MAS) 5. line invariant + 6. balance/min-lines (JournalEntry.assertPostable)
 *   7. allocate entry_no (NUM)  8. write entry + lines (the deferred balance trigger re-checks at commit)
 *
 * `reverse(...)` is implemented in the ledger-reverse brief; the aggregate's reverse() exists already.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '../../../common/ports/clock.port';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { JournalEntry } from '../domain/journal-entry';
import { PostingCommand } from '../domain/posting-command';
import { TAG_MATRIX, TagMatrix } from '../domain/tag-matrix';
import {
  JOURNAL_ENTRY_REPOSITORY,
  JournalEntryRepository,
} from '../domain/ports/journal-entry.repository';
import { NUMBERING_SERVICE } from '../domain/ports/numbering.service';
import type { NumberingService } from '../domain/ports/numbering.service';
import { PERIOD_SERVICE } from '../domain/ports/period.service';
import type { PeriodService } from '../domain/ports/period.service';
import {
  PROJECT_STATUS_SERVICE,
  ProjectStatusService,
} from '../domain/ports/project-status.service';
import {
  MASTER_LOOKUP_SERVICE,
  MasterLookupService,
} from '../domain/ports/master-lookup.service';

@Injectable()
export class PostingService {
  constructor(
    @Inject(JOURNAL_ENTRY_REPOSITORY) private readonly entries: JournalEntryRepository,
    @Inject(NUMBERING_SERVICE) private readonly numbering: NumberingService,
    @Inject(PERIOD_SERVICE) private readonly period: PeriodService,
    @Inject(TAG_MATRIX) private readonly tags: TagMatrix,
    @Inject(PROJECT_STATUS_SERVICE) private readonly projectStatus: ProjectStatusService,
    @Inject(MASTER_LOOKUP_SERVICE) private readonly masters: MasterLookupService,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async post(cmd: PostingCommand): Promise<JournalEntry> {
    // 1. period open (PER) — the voucher-date FY governs the period (design §10 item 2).
    await this.period.assertOpen(cmd.companyId, cmd.financialYearId, cmd.voucherDate);

    // 2. project not closed (MAS) — each distinct project referenced on the lines.
    const projectIds = [
      ...new Set(cmd.lines.map((l) => l.projectId).filter((p): p is string => !!p)),
    ];
    for (const projectId of projectIds) {
      await this.projectStatus.assertNotClosed(cmd.companyId, projectId);
    }

    // 3. tag matrix (overview §5.1) — required dimensions + party-on-control-account.
    this.tags.assert(cmd);

    // 4. reference validity (MAS) — same-company + active for every account/dimension/party.
    await this.masters.assertReferencesValid(cmd);

    // 5 + 6. line invariant + balance + min-lines — BEFORE numbering so a reject consumes no number.
    JournalEntry.assertPostable(cmd.lines);

    // 7. allocate the gapless entry_no (NUM) — last, only after all validation passed.
    const entryNo = await this.numbering.next(cmd.voucherType, cmd.companyId, cmd.financialYearId);

    // 8. build + write the immutable entry; the deferred balance trigger re-checks at commit.
    const entry = JournalEntry.create({ ...cmd, entryNo }, this.ids, this.clock);
    await this.entries.save(entry);
    return entry;
  }
}
