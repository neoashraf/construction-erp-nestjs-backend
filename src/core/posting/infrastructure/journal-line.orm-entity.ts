/**
 * JournalLineOrmEntity — line row for `journal_line` (INFRASTRUCTURE). Append-only. `debit`/`credit`
 * are `numeric(18,4)` via the `moneyTransformer` (string ↔ Decimal, exact money — never float). The four
 * posting dimensions + party are plain uuid columns; FKs to MAS masters (account/project/cost_centre/
 * purpose/godown/party) are added when those tables land — until then references are validated at the
 * app layer (MasterLookupService). The CHECKs + balance/append-only triggers live in the migration.
 */
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import Decimal from 'decimal.js';
import { moneyTransformer } from '../../../database/persistence/decimal.transformer';

@Entity({ name: 'journal_line' })
@Index('idx_journal_line_entry', ['journalEntryId'])
@Index('idx_journal_line_account', ['accountId'])
@Index('idx_journal_line_project', ['projectId'])
@Index('idx_journal_line_cost_centre', ['costCentreId'])
@Index('idx_journal_line_purpose', ['purposeId'])
@Index('idx_journal_line_godown', ['godownId'])
@Index('idx_journal_line_party', ['partyId'])
export class JournalLineOrmEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'journal_entry_id', type: 'uuid' })
  journalEntryId!: string;

  @Column({ name: 'line_no', type: 'int' })
  lineNo!: number;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId!: string | null;

  @Column({ name: 'cost_centre_id', type: 'uuid', nullable: true })
  costCentreId!: string | null;

  @Column({ name: 'purpose_id', type: 'uuid', nullable: true })
  purposeId!: string | null;

  @Column({ name: 'godown_id', type: 'uuid', nullable: true })
  godownId!: string | null;

  @Column({ name: 'party_id', type: 'uuid', nullable: true })
  partyId!: string | null;

  @Column({ name: 'debit', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  debit!: Decimal;

  @Column({ name: 'credit', type: 'numeric', precision: 18, scale: 4, transformer: moneyTransformer })
  credit!: Decimal;

  @Column({ name: 'narration', type: 'text', nullable: true })
  narration!: string | null;
}
