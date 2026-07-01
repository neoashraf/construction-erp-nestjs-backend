/**
 * TypeOrmRequisitionRepository (INFRASTRUCTURE) — persists the Requisition aggregate (header + lines +
 * approvals). Enrols in the active UnitOfWork via getManager. Every method is companyId-scoped (F3).
 * `findByIdForUpdate` takes a pessimistic row lock on the header inside a mutating UoW (anti-double
 * submit/approve). `save` bumps `version` under the optimistic-lock check, replaces the lines, and appends
 * any new approval rows (append-only — never rewrites existing ones). `nextRequisitionSeq` is a simple
 * per-company+FY counter (a requisition is not a legal/VAT document; non-gapless — SRS §16).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Requisition } from '../domain/requisition';
import { RequisitionRepository } from '../domain/ports/requisition.repository';
import { RequisitionMapper } from './requisition.mapper';
import { RequisitionApprovalOrmEntity } from './requisition-approval.orm-entity';
import { RequisitionLineOrmEntity } from './requisition-line.orm-entity';
import { RequisitionOrmEntity } from './requisition.orm-entity';

@Injectable()
export class TypeOrmRequisitionRepository implements RequisitionRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async insert(req: Requisition): Promise<void> {
    const m = getManager(this.dataSource);
    const header = RequisitionMapper.toOrm(req);
    header.version = 1;
    await m.getRepository(RequisitionOrmEntity).insert(header);
    const lines = req.props.lines.map((l) => RequisitionMapper.lineToOrm(req.id, l));
    if (lines.length) await m.getRepository(RequisitionLineOrmEntity).insert(lines);
  }

  async save(req: Requisition, expectedVersion: number): Promise<void> {
    const m = getManager(this.dataSource);
    const header = RequisitionMapper.toOrm(req);
    const res = await m
      .getRepository(RequisitionOrmEntity)
      .createQueryBuilder()
      .update()
      .set({
        requisitionNo: header.requisitionNo,
        requisitionSeq: header.requisitionSeq,
        projectId: header.projectId,
        costCentreId: header.costCentreId,
        purposeId: header.purposeId,
        fromGodownId: header.fromGodownId,
        requiredDate: header.requiredDate,
        priority: header.priority,
        status: header.status,
        estimatedValue: header.estimatedValue,
        approvalTier: header.approvalTier,
        submittedAt: header.submittedAt,
        submittedById: header.submittedById,
        closedAt: header.closedAt,
        closedReason: header.closedReason,
        narration: header.narration,
        version: expectedVersion + 1,
      })
      .where('id = :id AND company_id = :companyId AND version = :version', {
        id: header.id,
        companyId: header.companyId,
        version: expectedVersion,
      })
      .execute();
    if (!res.affected) {
      throw new OptimisticLockConflictError(`Requisition ${header.id} was modified concurrently`, {
        id: header.id,
      });
    }

    // Replace the lines (draft edits change them; a workflow transition leaves them unchanged but the
    // rewrite is idempotent). Delete-then-insert keeps line ordering + balances authoritative.
    const lineRepo = m.getRepository(RequisitionLineOrmEntity);
    await lineRepo.delete({ requisitionId: req.id });
    const lines = req.props.lines.map((l) => RequisitionMapper.lineToOrm(req.id, l));
    if (lines.length) await lineRepo.insert(lines);

    // Append any new approval rows (append-only — never touch existing ones).
    const approvalRepo = m.getRepository(RequisitionApprovalOrmEntity);
    const existing = new Set(
      (await approvalRepo.find({ where: { requisitionId: req.id }, select: { id: true } })).map((a) => a.id),
    );
    const newApprovals = req.approvals
      .filter((a) => !existing.has(a.props.id))
      .map((a) => RequisitionMapper.approvalToOrm(a));
    if (newApprovals.length) await approvalRepo.insert(newApprovals);
  }

  async findById(id: string, companyId: string): Promise<Requisition | null> {
    return this.load(id, companyId, false);
  }

  async findByIdForUpdate(id: string, companyId: string): Promise<Requisition | null> {
    return this.load(id, companyId, true);
  }

  private async load(id: string, companyId: string, lock: boolean): Promise<Requisition | null> {
    const m = getManager(this.dataSource);
    const qb = m
      .getRepository(RequisitionOrmEntity)
      .createQueryBuilder('r')
      .where('r.id = :id AND r.company_id = :companyId AND r.deleted_at IS NULL', { id, companyId });
    if (lock) qb.setLock('pessimistic_write');
    const header = await qb.getOne();
    if (!header) return null;
    const [lines, approvals] = await Promise.all([
      m.getRepository(RequisitionLineOrmEntity).find({ where: { requisitionId: id } }),
      m.getRepository(RequisitionApprovalOrmEntity).find({ where: { requisitionId: id } }),
    ]);
    return RequisitionMapper.toDomain(header, lines, approvals);
  }

  async softDelete(id: string, companyId: string): Promise<void> {
    await getManager(this.dataSource)
      .getRepository(RequisitionOrmEntity)
      .update({ id, companyId } as never, { deletedAt: new Date() });
  }

  async nextRequisitionSeq(companyId: string, financialYearId: string): Promise<number> {
    const rows: Array<{ max: string | null }> = await getManager(this.dataSource).query(
      `SELECT MAX(requisition_seq)::text AS max
         FROM requisition
        WHERE company_id = $1 AND financial_year_id = $2`,
      [companyId, financialYearId],
    );
    const max = rows[0]?.max ? parseInt(rows[0].max, 10) : 0;
    return max + 1;
  }
}
