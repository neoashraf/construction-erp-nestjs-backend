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
  lastLoginAt: Date | null;
  phone: string | null;
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
      lastLoginAt: null,
      phone: input.phone ?? null,
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

  deactivate(): void {
    this._props = { ...this._props, isActive: false };
  }

  activate(): void {
    this._props = { ...this._props, isActive: true };
  }
}
