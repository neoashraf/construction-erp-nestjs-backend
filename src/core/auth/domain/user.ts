/**
 * User aggregate (AUD domain — PURE TypeScript). Owns authentication state: password hash, lockout
 * counters, is_active, last_login_at. RBAC fields (roleId FK, project assignments) land in auth-rbac.
 * FR-AUD-001/002/006/008/009/016 (lockout §16 password policy).
 */
import { RoleName } from './role';

const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface UserProps {
  companyId: string;
  financialYearId: string;
  email: string;
  passwordHash: string;
  name: string;
  role: RoleName;
  isActive: boolean;
  /** Forced first-login change gate (FR-AUD-030). Behaviour lands in #38; this brief carries the column. */
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  phone: string | null;
  /** Cloudinary served URL of the profile photo; null when none (FR-AUD-038). */
  avatarUrl: string | null;
  /** Cloudinary asset handle for replace/delete; null when none; never returned to clients (FR-AUD-043). */
  avatarPublicId: string | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  version: number;
}

export class User {
  private constructor(
    readonly id: string,
    private _props: UserProps,
  ) {}

  get props(): Readonly<UserProps> {
    return this._props;
  }

  static create(
    id: string,
    input: {
      companyId: string;
      financialYearId: string;
      email: string;
      passwordHash: string;
      name: string;
      role: RoleName;
      phone?: string | null;
      isActive?: boolean;
    },
  ): User {
    if (!input.email || !input.email.includes('@')) {
      throw new Error('Invalid email');
    }
    if (!input.name.trim()) {
      throw new Error('Name is required');
    }
    return new User(id, {
      companyId: input.companyId,
      financialYearId: input.financialYearId,
      email: input.email.toLowerCase().trim(),
      passwordHash: input.passwordHash,
      name: input.name.trim(),
      role: input.role,
      isActive: input.isActive ?? true,
      mustChangePassword: true,
      lastLoginAt: null,
      phone: input.phone ?? null,
      avatarUrl: null,
      avatarPublicId: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      version: 1,
    });
  }

  static rehydrate(id: string, props: UserProps): User {
    return new User(id, { ...props });
  }

  /** Returns true if the lockout window is currently active (FR-AUD-001, §16 password policy). */
  isLockedOut(now: Date): boolean {
    return this._props.lockedUntil !== null && now < this._props.lockedUntil;
  }

  /** Record a failed login attempt; locks for 15 min after 5 consecutive failures (FR-AUD-001). */
  recordFailedLogin(now: Date): void {
    const attempts = this._props.failedLoginAttempts + 1;
    const lockedUntil =
      attempts >= LOCKOUT_ATTEMPTS
        ? new Date(now.getTime() + LOCKOUT_MINUTES * 60 * 1000)
        : this._props.lockedUntil;
    this._props = { ...this._props, failedLoginAttempts: attempts, lockedUntil };
  }

  /** Successful login: reset lockout, stamp last_login_at (FR-AUD-008). */
  recordSuccessfulLogin(now: Date): void {
    this._props = {
      ...this._props,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: now,
    };
  }

  /** Re-hash the password (FR-AUD-006). */
  changePasswordHash(newHash: string): void {
    this._props = { ...this._props, passwordHash: newHash };
  }

  /** Re-arm the forced first-login change gate (Admin create/reset — FR-AUD-030). */
  markMustChangePassword(): void {
    this._props = { ...this._props, mustChangePassword: true };
  }

  /** Clear the forced-change gate on a successful self-service change (FR-AUD-030). */
  clearMustChangePassword(): void {
    this._props = { ...this._props, mustChangePassword: false };
  }

  /**
   * Self-service profile edit — display name and/or phone only (FR-AUD-032/034). Authorization-bearing
   * fields are never touched here. `name`, when given, is trimmed and must be non-empty (Bangla-safe).
   * `phone` may be a value (validated E.164 by the caller) or null to clear. Returns before/after for audit.
   */
  editProfile(input: { name?: string; phone?: string | null }): {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  } {
    const before = { name: this._props.name, phone: this._props.phone };
    let name = this._props.name;
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) throw new Error('Name is required');
      name = trimmed;
    }
    const phone = input.phone !== undefined ? input.phone : this._props.phone;
    this._props = { ...this._props, name, phone };
    return { before, after: { name, phone } };
  }

  /** Upload/replace the profile photo (FR-AUD-038). Stores only the served URL + asset handle. */
  setAvatar(url: string, publicId: string): void {
    this._props = { ...this._props, avatarUrl: url, avatarPublicId: publicId };
  }

  /** Remove the profile photo (FR-AUD-041). Clears both fields; idempotent at the aggregate level. */
  clearAvatar(): void {
    this._props = { ...this._props, avatarUrl: null, avatarPublicId: null };
  }

  deactivate(): void {
    this._props = { ...this._props, isActive: false };
  }

  activate(): void {
    this._props = { ...this._props, isActive: true };
  }
}
