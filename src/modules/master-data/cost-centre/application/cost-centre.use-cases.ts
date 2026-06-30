/**
 * CostCentre use cases (FR-MAS-009/010/029/033). Create / rename / deactivate / reactivate +
 * the idempotent standard-14 seed. Audit on every mutation via the core AuditService seam.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService, AuditAction } from '../../../../core/audit/application/audit.port';
import { assertVersion } from '../../application/optimistic-lock';
import { CostCentre } from '../domain/cost-centre';
import { TypeOrmCostCentreRepository } from '../infrastructure/typeorm-cost-centre.repository';

/** The standard 14 construction cost centres seeded per company (FR-MAS-009, design §8). */
export const STANDARD_COST_CENTRES: { code: string; name: string }[] = [
  { code: 'CC-EXC', name: 'Excavation' },
  { code: 'CC-FND', name: 'Foundation' },
  { code: 'CC-CLB', name: 'Column & Beam' },
  { code: 'CC-SLB', name: 'Slab' },
  { code: 'CC-BRK', name: 'Brickwork' },
  { code: 'CC-PLS', name: 'Plastering' },
  { code: 'CC-FLR', name: 'Flooring' },
  { code: 'CC-PLM', name: 'Plumbing' },
  { code: 'CC-ELE', name: 'Electrical' },
  { code: 'CC-PNT', name: 'Painting' },
  { code: 'CC-FIN', name: 'Finishing' },
  { code: 'CC-OVH', name: 'Overheads' },
  { code: 'CC-SAF', name: 'Safety' },
  { code: 'CC-MCH', name: 'Machinery Rental' },
];

@Injectable()
export class CreateCostCentreUseCase {
  constructor(
    private readonly repo: TypeOrmCostCentreRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  async execute(input: { code: string; name: string }, actor: Actor): Promise<{ id: string }> {
    const cc = CostCentre.create({ companyId: actor.companyId, ...input }, this.ids);
    await this.uow.run(async () => {
      await this.repo.insert(cc);
      await record(this.audit, 'CREATE', cc.id, actor);
    });
    return { id: cc.id };
  }
}

@Injectable()
export class SeedStandardCostCentresUseCase {
  constructor(
    private readonly repo: TypeOrmCostCentreRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  /** Idempotent — re-running inserts nothing (ON CONFLICT DO NOTHING). Call inside the caller's UoW. */
  async execute(companyId: string): Promise<void> {
    await this.repo.seedIfAbsent(
      STANDARD_COST_CENTRES.map((c) => ({ id: this.ids.next(), companyId, code: c.code, name: c.name })),
    );
  }
}

abstract class MutateCostCentre {
  constructor(
    protected readonly repo: TypeOrmCostCentreRepository,
    @Inject(AUDIT_SERVICE) protected readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) protected readonly uow: UnitOfWork,
  ) {}
  protected async load(id: string, actor: Actor): Promise<CostCentre> {
    const cc = await this.repo.findById(id, actor.companyId);
    if (!cc) throw new NotFoundError(`Cost centre ${id} not found`);
    return cc;
  }
}

@Injectable()
export class RenameCostCentreUseCase extends MutateCostCentre {
  async execute(id: string, name: string, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const cc = await this.load(id, actor);
      assertVersion(cc.version, version, 'CostCentre', id);
      cc.rename(name);
      await this.repo.update(cc, version);
      await record(this.audit, 'UPDATE', id, actor);
    });
  }
}

@Injectable()
export class DeactivateCostCentreUseCase extends MutateCostCentre {
  async execute(id: string, version: number, actor: Actor): Promise<void> {
    await this.toggle(id, version, actor, false, 'DEACTIVATE');
  }
  protected async toggle(id: string, version: number, actor: Actor, active: boolean, action: AuditAction): Promise<void> {
    await this.uow.run(async () => {
      const cc = await this.load(id, actor);
      assertVersion(cc.version, version, 'CostCentre', id);
      if (active) cc.reactivate();
      else cc.deactivate();
      await this.repo.update(cc, version);
      await record(this.audit, action, id, actor);
    });
  }
}

@Injectable()
export class ReactivateCostCentreUseCase extends DeactivateCostCentreUseCase {
  override async execute(id: string, version: number, actor: Actor): Promise<void> {
    await this.toggle(id, version, actor, true, 'REACTIVATE');
  }
}

function record(audit: AuditService, action: AuditAction, id: string, actor: Actor): Promise<void> {
  return audit.record({ action, entityType: 'CostCentre', entityId: id, actorId: actor.userId, companyId: actor.companyId });
}
