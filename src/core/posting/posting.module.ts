/**
 * Posting kernel module (LED) — composition root. Binds the ports PostingService depends on:
 *   - JOURNAL_ENTRY_REPOSITORY → TypeOrmJournalEntryRepository;
 *   - TAG_MATRIX → OverviewTagMatrix (pure domain service);
 *   - NUMBERING_SERVICE / PERIOD_SERVICE → re-exported from NumberingModule / PeriodModule;
 *   - PROJECT_STATUS_SERVICE / MASTER_LOOKUP_SERVICE → permissive MAS seams (rebind when MAS lands).
 * Exports PostingService so voucher modules can post inside their own UnitOfWork. AUDIT_SERVICE global.
 */
import { Module } from '@nestjs/common';
import { NumberingModule } from '../numbering/numbering.module';
import { PeriodModule } from '../period/period.module';
import { PostingService } from './application/posting.service';
import { JOURNAL_ENTRY_REPOSITORY } from './domain/ports/journal-entry.repository';
import { TypeOrmJournalEntryRepository } from './infrastructure/typeorm-journal-entry.repository';
import { TAG_MATRIX, OverviewTagMatrix } from './domain/tag-matrix';
import { PROJECT_STATUS_SERVICE } from './domain/ports/project-status.service';
import { MASTER_LOOKUP_SERVICE } from './domain/ports/master-lookup.service';
import {
  AllowAllMasterLookupService,
  AllowAllProjectStatusService,
} from './infrastructure/mas-seam.adapters';

@Module({
  imports: [NumberingModule, PeriodModule],
  providers: [
    PostingService,
    { provide: JOURNAL_ENTRY_REPOSITORY, useClass: TypeOrmJournalEntryRepository },
    { provide: TAG_MATRIX, useClass: OverviewTagMatrix },
    { provide: PROJECT_STATUS_SERVICE, useClass: AllowAllProjectStatusService },
    { provide: MASTER_LOOKUP_SERVICE, useClass: AllowAllMasterLookupService },
  ],
  exports: [PostingService],
})
export class PostingModule {}
