/**
 * RetentionReleaseMapper (INFRASTRUCTURE) — translates the pure RetentionRelease aggregate <-> the
 * `retention_release` ORM row. The domain never imports TypeORM; this is the only seam.
 */
import Decimal from 'decimal.js';
import { Money } from '../../../common/money';
import { RetentionRelease, RetentionReleaseStatus } from '../domain/retention-release';
import { RetentionReleaseOrmEntity } from './retention-release.orm-entity';

export const RetentionReleaseMapper = {
  toOrm(release: RetentionRelease): RetentionReleaseOrmEntity {
    const p = release.props;
    const e = new RetentionReleaseOrmEntity();
    e.id = release.id;
    e.companyId = p.companyId;
    e.financialYearId = p.financialYearId;
    e.ipcId = p.ipcId;
    e.projectId = p.projectId;
    e.customerId = p.customerId;
    e.costCentreId = p.costCentreId;
    e.purposeId = p.purposeId;
    e.releaseDate = p.releaseDate;
    e.releasedAmount = p.releasedAmount.amount;
    e.narration = p.narration;
    e.status = p.status;
    e.entryNo = p.entryNo;
    e.journalEntryId = p.journalEntryId;
    e.postedAt = p.postedAt;
    e.postedBy = p.postedBy;
    return e;
  },

  toDomain(r: RetentionReleaseOrmEntity): RetentionRelease {
    return RetentionRelease.rehydrate(r.id, {
      companyId: r.companyId,
      financialYearId: r.financialYearId,
      ipcId: r.ipcId,
      projectId: r.projectId,
      customerId: r.customerId,
      costCentreId: r.costCentreId,
      purposeId: r.purposeId,
      releaseDate: r.releaseDate,
      releasedAmount: Money.of(new Decimal(r.releasedAmount)),
      narration: r.narration,
      status: r.status as RetentionReleaseStatus,
      entryNo: r.entryNo,
      journalEntryId: r.journalEntryId,
      postedAt: r.postedAt,
      postedBy: r.postedBy,
      version: r.version,
    });
  },
};
