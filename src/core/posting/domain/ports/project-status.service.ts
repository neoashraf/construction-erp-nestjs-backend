/**
 * ProjectStatusService — MAS-owned PORT (pure). The closed-project guard consulted by PostingService
 * before a write (FR-LED-019). Throws `ProjectClosedError` if the project is CLOSED. The real adapter
 * (delegating to MAS's project query) lands with master-data-dimensions; until then a permissive seam
 * is bound (allow-all) and the rejection path is covered by use-case tests with a fake.
 */
export interface ProjectStatusService {
  assertNotClosed(companyId: string, projectId: string): Promise<void>;
}

export const PROJECT_STATUS_SERVICE = Symbol('ProjectStatusService');
