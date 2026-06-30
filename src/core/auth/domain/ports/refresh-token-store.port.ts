/** RefreshTokenStore port — server-side allowlist of live JTIs (FR-AUD-004/005, design §1). */
export interface RefreshTokenStore {
  /** Record a newly-issued JTI as live; returns it for the caller to sign into the token. */
  issue(userId: string, companyId: string, expiresAt: Date): Promise<string>;
  /** True if jti is in the store AND not revoked AND not expired. */
  isLive(jti: string): Promise<boolean>;
  /** Remove a single JTI (logout). Idempotent — revoked JTI is still rejected. */
  revoke(jti: string): Promise<void>;
  /** Remove all JTIs for a user (change-password / deactivate). */
  revokeAllFor(userId: string): Promise<void>;
}
export const REFRESH_TOKEN_STORE = Symbol('RefreshTokenStore');
