/**
 * TagConsistencyServiceImpl (CC application) — enforces FR-CC-004 (§5.2). For every draft line that
 * carries a `purpose`/`godown`, resolve that dimension's owning project (MAS) and assert it equals the
 * line's `project`. A mismatch (or a dangling id whose owner differs) raises
 * `CrossProjectDimensionError` → `400 CROSS_PROJECT_DIMENSION` on the calling voucher endpoint. Batches
 * the id→project lookups so a multi-line voucher costs at most two queries.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CrossProjectDimensionError } from '../domain/errors';
import {
  CompanyContext,
  TagConsistencyService,
  TagLine,
} from '../domain/ports/tag-consistency.port';
import {
  COST_CONTROL_READ_REPOSITORY,
  CostControlReadRepository,
} from '../domain/ports/cost-control.read.port';

@Injectable()
export class TagConsistencyServiceImpl implements TagConsistencyService {
  constructor(
    @Inject(COST_CONTROL_READ_REPOSITORY)
    private readonly repo: CostControlReadRepository,
  ) {}

  async assertConsistent(ctx: CompanyContext, lines: TagLine[]): Promise<void> {
    const purposeIds = uniq(lines.map((l) => l.purposeId).filter(isId));
    const godownIds = uniq(lines.map((l) => l.godownId).filter(isId));
    if (purposeIds.length === 0 && godownIds.length === 0) return;

    const [purposeProject, godownProject] = await Promise.all([
      purposeIds.length ? this.repo.projectOfPurposes(ctx.companyId, purposeIds) : emptyMap(),
      godownIds.length ? this.repo.projectOfGodowns(ctx.companyId, godownIds) : emptyMap(),
    ]);

    for (const line of lines) {
      if (isId(line.purposeId)) {
        const owner = purposeProject.get(line.purposeId) ?? null;
        if (owner !== line.projectId) {
          throw new CrossProjectDimensionError('purpose', line.purposeId, line.projectId, owner);
        }
      }
      if (isId(line.godownId)) {
        const owner = godownProject.get(line.godownId) ?? null;
        if (owner !== line.projectId) {
          throw new CrossProjectDimensionError('godown', line.godownId, line.projectId, owner);
        }
      }
    }
  }
}

function isId(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}
function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}
function emptyMap(): Promise<Map<string, string>> {
  return Promise.resolve(new Map());
}
