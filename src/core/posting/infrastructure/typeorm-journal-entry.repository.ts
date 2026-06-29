/**
 * TypeOrmJournalEntryRepository (INFRASTRUCTURE). Enrols in the active UnitOfWork via `getManager`.
 * Uses INSERT (never save/update) so the append-only trigger is never tripped. `existsReversalOf` is a
 * COUNT over `reversal_of` — the derived "already reversed?" check (FR-LED-026/028).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { JournalEntry } from '../domain/journal-entry';
import { JournalEntryRepository } from '../domain/ports/journal-entry.repository';
import { JournalEntryMapper } from './journal-entry.mapper';
import { JournalEntryOrmEntity } from './journal-entry.orm-entity';
import { JournalLineOrmEntity } from './journal-line.orm-entity';

@Injectable()
export class TypeOrmJournalEntryRepository implements JournalEntryRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async save(entry: JournalEntry): Promise<void> {
    const manager = getManager(this.dataSource);
    const { entry: e, lines } = JournalEntryMapper.toOrm(entry);
    await manager.getRepository(JournalEntryOrmEntity).insert(e);
    await manager.getRepository(JournalLineOrmEntity).insert(lines);
  }

  async findById(id: string, companyId: string): Promise<JournalEntry | null> {
    const manager = getManager(this.dataSource);
    const e = await manager.getRepository(JournalEntryOrmEntity).findOne({ where: { id, companyId } });
    if (!e) return null;
    const lines = await manager
      .getRepository(JournalLineOrmEntity)
      .find({ where: { journalEntryId: id }, order: { lineNo: 'ASC' } });
    return JournalEntryMapper.toDomain(e, lines);
  }

  async existsReversalOf(id: string, companyId: string): Promise<boolean> {
    const count = await getManager(this.dataSource)
      .getRepository(JournalEntryOrmEntity)
      .count({ where: { reversalOf: id, companyId } });
    return count > 0;
  }
}
