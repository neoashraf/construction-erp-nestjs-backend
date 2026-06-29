/**
 * TypeOrmNumberingService — the ONLY NumberingService implementation and the ONLY writer of the
 * counter row (INFRASTRUCTURE). It runs on the AMBIENT transactional manager from the caller's
 * UnitOfWork (AsyncLocalStorage) and NEVER opens its own transaction (FR-NUM-008).
 *
 * Allocation (FR-NUM-009..014):
 *   1. SELECT the series row FOR UPDATE on the (company, FY, voucher type) triple.
 *   2. If absent → auto-provision at last_sequence=0 inside a SAVEPOINT (so a concurrent first-post's
 *      unique-violation doesn't poison the outer tx), then re-SELECT … FOR UPDATE.
 *   3. seq = last_sequence + 1; UPDATE last_sequence = seq (held under the lock until commit).
 *   4. Derive the FY short label from `financial_year`; format `<prefix>/<label>/<zeroPad(seq)>`.
 * The lock serialises concurrent posts per series; the increment commits/rolls back with the caller's
 * transaction, so a failed post consumes no number (FR-NUM-010, FR-NUM-011).
 */
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';
import { ValidationError } from '../../../common/errors/domain-error';
import { ID_GENERATOR, IdGenerator } from '../../../common/ports/id-generator.port';
import { getActiveManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { NumberingService } from '../../posting/domain/ports/numbering.service';
import { VoucherType } from '../../posting/domain/voucher-type';
import {
  DEFAULT_PADDING_WIDTH,
  defaultPrefixFor,
  formatVoucherNumber,
  fyShortLabel,
} from '../domain/numbering-series';
import { NumberingSeriesOrmEntity } from './numbering-series.orm-entity';

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class TypeOrmNumberingService implements NumberingService {
  constructor(@Inject(ID_GENERATOR) private readonly ids: IdGenerator) {}

  async next(voucherType: VoucherType, companyId: string, fyId: string): Promise<string> {
    const manager = getActiveManager();
    if (!manager) {
      // NUM must never open its own transaction — it allocates inside the post's UnitOfWork.
      throw new Error('NumberingService.next() must run inside a UnitOfWork transaction');
    }

    let series = await this.lockSeries(manager, voucherType, companyId, fyId);
    if (!series) {
      await this.provision(manager, voucherType, companyId, fyId);
      series = await this.lockSeries(manager, voucherType, companyId, fyId);
      if (!series) {
        // unreachable: provision either inserted the row or lost the race to a now-committed row.
        throw new Error('numbering series could not be provisioned');
      }
    }

    const seq = series.lastSequence + 1;
    await manager.update(NumberingSeriesOrmEntity, { id: series.id }, { lastSequence: seq });

    const label = await this.resolveFyShortLabel(manager, companyId, fyId);
    return formatVoucherNumber(series.prefix, label, seq, series.paddingWidth);
  }

  /** SELECT … FOR UPDATE the series row for the triple (point lookup on the unique index). */
  private lockSeries(
    manager: EntityManager,
    voucherType: VoucherType,
    companyId: string,
    fyId: string,
  ): Promise<NumberingSeriesOrmEntity | null> {
    return manager
      .createQueryBuilder(NumberingSeriesOrmEntity, 's')
      .setLock('pessimistic_write')
      .where(
        's.company_id = :companyId AND s.financial_year_id = :fyId AND s.voucher_type = :voucherType',
        { companyId, fyId, voucherType },
      )
      .getOne();
  }

  /**
   * Auto-provision a missing series at last_sequence=0 (FR-NUM-004). Wrapped in a SAVEPOINT so a
   * concurrent first-post that wins the unique-constraint race raises 23505 WITHOUT aborting the outer
   * transaction — we roll back to the savepoint and let the caller re-SELECT the now-existing row.
   */
  private async provision(
    manager: EntityManager,
    voucherType: VoucherType,
    companyId: string,
    fyId: string,
  ): Promise<void> {
    await manager.query('SAVEPOINT num_provision');
    try {
      await manager.insert(NumberingSeriesOrmEntity, {
        id: this.ids.next(),
        companyId,
        financialYearId: fyId,
        voucherType,
        prefix: defaultPrefixFor(voucherType),
        paddingWidth: DEFAULT_PADDING_WIDTH,
        lastSequence: 0,
      });
      await manager.query('RELEASE SAVEPOINT num_provision');
    } catch (err) {
      await manager.query('ROLLBACK TO SAVEPOINT num_provision');
      if (!TypeOrmNumberingService.isUniqueViolation(err)) throw err;
      // else: another transaction committed the row first — the caller will re-SELECT it FOR UPDATE.
    }
  }

  /** FY short label (e.g. `2526`) from the financial year's start/end years (FR-NUM-013). */
  private async resolveFyShortLabel(
    manager: EntityManager,
    companyId: string,
    fyId: string,
  ): Promise<string> {
    const rows: Array<{ sy: string; ey: string }> = await manager.query(
      `SELECT to_char(start_date, 'YYYY') AS sy, to_char(end_date, 'YYYY') AS ey
         FROM financial_year WHERE id = $1 AND company_id = $2`,
      [fyId, companyId],
    );
    if (rows.length === 0) {
      throw new ValidationError('financial year not found for numbering', { companyId, fyId });
    }
    return fyShortLabel(parseInt(rows[0].sy, 10), parseInt(rows[0].ey, 10));
  }

  private static isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof QueryFailedError &&
      (err as QueryFailedError & { driverError?: { code?: string } }).driverError?.code ===
        PG_UNIQUE_VIOLATION
    );
  }
}
