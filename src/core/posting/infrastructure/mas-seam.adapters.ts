/**
 * MAS seam adapters (INFRASTRUCTURE) — temporary permissive stand-ins for the MAS-owned posting
 * guards, bound until master-data-dimensions / master-data-accounts-parties-items land:
 *   - AllowAllProjectStatusService: never rejects (no project is "closed" yet).
 *   - AllowAllMasterLookupService: never rejects (references assumed valid).
 * REBIND these to the real MAS-querying adapters when those briefs ship — the ports + the
 * PostingService orchestration do not change. The rejection paths (closed project, cross-company /
 * inactive reference) are covered by use-case tests with fakes (AC10/AC11).
 */
import { Injectable } from '@nestjs/common';
import { ProjectStatusService } from '../domain/ports/project-status.service';
import { MasterLookupService } from '../domain/ports/master-lookup.service';

@Injectable()
export class AllowAllProjectStatusService implements ProjectStatusService {
  assertNotClosed(): Promise<void> {
    return Promise.resolve();
  }
}

@Injectable()
export class AllowAllMasterLookupService implements MasterLookupService {
  assertReferencesValid(): Promise<void> {
    return Promise.resolve();
  }
}
