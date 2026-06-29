/**
 * MasterLookupService — MAS-owned PORT (pure). Validates that every account/dimension/party referenced
 * by a posting command belongs to the command's company and is active (FR-LED-013): a cross-company or
 * deactivated reference is rejected. The real adapter (querying MAS masters) lands with
 * master-data-accounts-parties-items; until then a permissive seam is bound and the rejection path is
 * covered by use-case tests with a fake.
 */
import { PostingCommand } from '../posting-command';

export interface MasterLookupService {
  assertReferencesValid(cmd: PostingCommand): Promise<void>;
}

export const MASTER_LOOKUP_SERVICE = Symbol('MasterLookupService');
