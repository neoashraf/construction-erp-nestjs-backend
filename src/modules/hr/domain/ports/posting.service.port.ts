/**
 * PostingServicePort (LED, driven). PURE interface — HR depends on this, the HR module binds it to the
 * REAL core PostingService. The ONLY ledger writer: HR builds a balanced PostingCommand and calls post()
 * inside its OWN uow.run (FR-LED-002/-016/-017); reverse() writes a linked swapped-side entry for the
 * reverse-and-repost correction (FR-HR-012). HR writes NO journal row itself.
 */
import { JournalEntry } from '../../../../core/posting/domain/journal-entry';
import { PostingCommand } from '../../../../core/posting/domain/posting-command';

export interface PostingServicePort {
  post(cmd: PostingCommand): Promise<JournalEntry>;
  reverse(entryId: string, companyId: string, reason: string, reversedBy: string): Promise<JournalEntry>;
}

export const POSTING_SERVICE_PORT = Symbol('PostingServicePort');
