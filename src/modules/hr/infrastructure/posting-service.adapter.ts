/**
 * PostingServiceAdapter (INFRASTRUCTURE) — binds HR's PostingServicePort to the REAL core PostingService
 * (the single ledger writer). HR calls post()/reverse() through this thin delegate so the domain/
 * application depend on an interface, not on core's concrete class (ports/adapters, ADR-0002 F5/F6).
 */
import { Injectable } from '@nestjs/common';
import { PostingService } from '../../../core/posting/application/posting.service';
import { JournalEntry } from '../../../core/posting/domain/journal-entry';
import { PostingCommand } from '../../../core/posting/domain/posting-command';
import { PostingServicePort } from '../domain/ports/posting.service.port';

@Injectable()
export class PostingServiceAdapter implements PostingServicePort {
  constructor(private readonly posting: PostingService) {}

  post(cmd: PostingCommand): Promise<JournalEntry> {
    return this.posting.post(cmd);
  }

  reverse(entryId: string, companyId: string, reason: string, reversedBy: string): Promise<JournalEntry> {
    return this.posting.reverse(entryId, companyId, reason, reversedBy);
  }
}
