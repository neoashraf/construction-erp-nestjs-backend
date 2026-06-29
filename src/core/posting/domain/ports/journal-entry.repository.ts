/**
 * JournalEntryRepository — domain PORT (pure). Persists/loads the aggregate; `existsReversalOf` is the
 * derived "already reversed?" check (a COUNT WHERE reversal_of = id), used by the reverse brief
 * (FR-LED-026, FR-LED-028). Enrols in the active UnitOfWork transaction.
 */
import { JournalEntry } from '../journal-entry';

export interface JournalEntryRepository {
  save(entry: JournalEntry): Promise<void>;
  findById(id: string, companyId: string): Promise<JournalEntry | null>;
  existsReversalOf(id: string, companyId: string): Promise<boolean>;
}

export const JOURNAL_ENTRY_REPOSITORY = Symbol('JournalEntryRepository');
