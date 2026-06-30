/** TokenSigner port — signs/verifies JWT access and refresh tokens (FR-AUD-003/004). */
import { RoleName } from '../role';

export interface AccessClaims {
  sub: string;         // userId
  companyId: string;
  financialYearId: string;
  role: RoleName;
}

export interface RefreshClaims {
  sub: string;         // userId
  jti: string;         // unique token id (server-side allowlist key)
  companyId: string;
}

export interface TokenSigner {
  signAccess(claims: AccessClaims): string;
  signRefresh(claims: RefreshClaims): string;
  verifyAccess(token: string): AccessClaims;
  verifyRefresh(token: string): RefreshClaims;
}
export const TOKEN_SIGNER = Symbol('TokenSigner');
