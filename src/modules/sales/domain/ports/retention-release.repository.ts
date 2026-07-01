/**
 * RetentionReleaseRepository port (SAL-owned, driven). PURE interface — persist/load the RetentionRelease
 * aggregate. Every method is companyId-scoped (F3). `insert` for the create-and-post-in-one-request flow
 * (releases have no editable-draft step in the UI — createDraft + assertReleasable + post happen in one
 * use-case transaction, mirroring the API contract's single `POST …/release-retention` action).
 */
import { Money } from '../../../../common/money';
import { RetentionRelease } from '../retention-release';

export interface RetentionReleaseListFilter {
  ipcId: string;
}

export interface RetentionReleaseRepository {
  insert(release: RetentionRelease): Promise<void>;
  save(release: RetentionRelease, expectedVersion: number): Promise<void>;
  findById(id: string, companyId: string): Promise<RetentionRelease | null>;
  findByIdForUpdate(id: string, companyId: string): Promise<RetentionRelease | null>;
  listByIpc(ipcId: string, companyId: string): Promise<RetentionRelease[]>;
  /** Sum of `released_amount` for POSTED releases against the IPC — the held formula's subtrahend (FR-SAL-019). */
  sumPostedReleasedForIpc(ipcId: string, companyId: string): Promise<Money>;
}

export const RETENTION_RELEASE_REPOSITORY = Symbol('RetentionReleaseRepository');
