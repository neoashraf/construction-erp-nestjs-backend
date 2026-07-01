/**
 * TypeOrmRequisitionRepository (INFRASTRUCTURE) — persists the Requisition aggregate (header + lines +
 * approvals). Enrols in the active UnitOfWork via getManager. Every method is companyId-scoped (F3).
 * `findByIdForUpdate` takes a pessimistic row lock on the header inside a mutating UoW (anti-double
 * submit/approve). `save` bumps `version` under the optimistic-lock check, replaces the lines, and appends
 * any new approval rows (append-only — never rewrites existing ones). `nextRequisitionSeq` is a simple
 * per-company+FY counter (a requisition is not a legal/VAT document; non-gapless — SRS §16). Brief #23
 * adds `findLineForUpdate` (the line-balance lock) + the RequisitionIssue persistence methods (append-only).
 */
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { NotFoundError, OptimisticLockConflictError } from '../../../common/errors/domain-error';
import { getManager } from '../../../infrastructure/unit-of-work/transaction-context';
import { Requisition } from '../domain/requisition';
import { RequisitionIssue } from '../domain/requisition-issue';
import {
  RequisitionLineForUpdate,
  RequisitionRepository,
} from '../domain/ports/requisition.repository';
import { RequisitionMapper } from './requisition.mapper';
import { RequisitionIssueMapper } from './requisition-issue.mapper';
import { RequisitionApprovalOrmEntity } from './requisition-approval.orm-entity';
import { RequisitionLineOrmEntity } from './requisition-line.orm-entity';
import { RequisitionIssueLineOrmEntity } from './requisition-issue-line.orm-entity';
import { RequisitionIssueOrmEntity } from './requisition-issue.orm-entity';
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

    // Upsert the lines by id (draft edits change them; an issue only mutates issued/balance quantities on
    // the SAME line ids). UPDATE-existing/INSERT-new/DELETE-orphaned — never delete-then-reinsert a line
    // whose id is still current, because `requisition_issue_line.requisition_line_id` FKs to it (ON DELETE
    // RESTRICT) once an issue references that line; a blind delete-then-insert would trip that FK.
    const lineRepo = m.getRepository(RequisitionLineOrmEntity);
    const existingLineIds = new Set(
      (await lineRepo.find({ where: { requisitionId: req.id }, select: { id: true } })).map((l) => l.id),
    );
    const currentLines = req.props.lines.map((l) => RequisitionMapper.lineToOrm(req.id, l));
    const currentLineIds = new Set(currentLines.map((l) => l.id));
    const toInsert = currentLines.filter((l) => !existingLineIds.has(l.id));
    const toUpdate = currentLines.filter((l) => existingLineIds.has(l.id));
    const toDeleteIds = [...existingLineIds].filter((id) => !currentLineIds.has(id));
    if (toInsert.length) await lineRepo.insert(toInsert);
    for (const l of toUpdate) {
      await lineRepo.update({ id: l.id } as never, {
        lineNo: l.lineNo,
        itemId: l.itemId,
        requestedQuantity: l.requestedQuantity,
        issuedQuantity: l.issuedQuantity,
        balanceQuantity: l.balanceQuantity,
        indicativeRate: l.indicativeRate,
        uom: l.uom,
      });
    }
    if (toDeleteIds.length) await lineRepo.delete(toDeleteIds);

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

  async findLineForUpdate(lineId: string, companyId: string): Promise<RequisitionLineForUpdate | null> {
    const m = getManager(this.dataSource);
    const rows: Array<{
      id: string;
      requisition_id: string;
      item_id: string;
      balance_quantity: string;
    }> = await m.query(
      `SELECT rl.id, rl.requisition_id, rl.item_id, rl.balance_quantity::text AS balance_quantity
         FROM requisition_line rl
         JOIN requisition r ON r.id = rl.requisition_id
        WHERE rl.id = $1 AND r.company_id = $2 AND r.deleted_at IS NULL
        FOR UPDATE OF rl`,
      [lineId, companyId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      id: row.id,
      requisitionId: row.requisition_id,
      itemId: row.item_id,
      balanceQuantity: new Decimal(row.balance_quantity),
    };
  }

  async saveIssue(issue: RequisitionIssue): Promise<void> {
    const m = getManager(this.dataSource);
    const header = RequisitionIssueMapper.toOrm(issue);
    await m.getRepository(RequisitionIssueOrmEntity).insert(header);
    const lines = issue.lines.map((l) => RequisitionIssueMapper.lineToOrm(issue.id, l));
    if (lines.length) await m.getRepository(RequisitionIssueLineOrmEntity).insert(lines);
  }

  async saveIssueReversal(issue: RequisitionIssue): Promise<void> {
    const m = getManager(this.dataSource);
    const p = issue.props;
    await m.getRepository(RequisitionIssueOrmEntity).update(
      { id: issue.id } as never,
      { reversedAt: p.reversedAt, reversedById: p.reversedById },
    );
  }

  async findIssue(requisitionId: string, issueId: string, companyId: string): Promise<RequisitionIssue | null> {
    const m = getManager(this.dataSource);
    const header = await m.getRepository(RequisitionIssueOrmEntity).findOne({
      where: { id: issueId, requisitionId } as never,
    });
    if (!header) return null;
    // Company scope is enforced via the parent requisition (issue rows carry no company_id of their own).
    const owner = await m
      .getRepository(RequisitionOrmEntity)
      .findOne({ where: { id: requisitionId, companyId } as never });
    if (!owner) throw new NotFoundError(`Requisition ${requisitionId} not found`);
    const lines = await m
      .getRepository(RequisitionIssueLineOrmEntity)
      .find({ where: { requisitionIssueId: issueId } });
    return RequisitionIssueMapper.toDomain(header, lines);
  }

  async listIssues(requisitionId: string, companyId: string): Promise<RequisitionIssue[]> {
    const m = getManager(this.dataSource);
    const owner = await m
      .getRepository(RequisitionOrmEntity)
      .findOne({ where: { id: requisitionId, companyId } as never });
    if (!owner) throw new NotFoundError(`Requisition ${requisitionId} not found`);
    const headers = await m
      .getRepository(RequisitionIssueOrmEntity)
      .find({ where: { requisitionId }, order: { issueNo: 'ASC' } });
    const result: RequisitionIssue[] = [];
    for (const header of headers) {
      const lines = await m
        .getRepository(RequisitionIssueLineOrmEntity)
        .find({ where: { requisitionIssueId: header.id } });
      result.push(RequisitionIssueMapper.toDomain(header, lines));
    }
    return result;
  }

  async nextIssueNo(requisitionId: string): Promise<number> {
    const rows: Array<{ max: string | null }> = await getManager(this.dataSource).query(
      `SELECT MAX(issue_no)::text AS max FROM requisition_issue WHERE requisition_id = $1`,
      [requisitionId],
    );
    const max = rows[0]?.max ? parseInt(rows[0].max, 10) : 0;
    return max + 1;
  }
}
