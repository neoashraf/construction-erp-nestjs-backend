/**
 * Company — organisation master (MAS, FR-MAS-001, FR-MAS-004). PURE domain TypeScript:
 * no NestJS, no TypeORM, no decorators. Holds identity (name/legal name, BIN/TIN), localization
 * defaults (currency/date format/locale), and the active flag. Company is the tenant root, so it
 * carries no `company_id` of its own — its own `id` IS the tenant key (scoping is by `id`).
 *
 * Lean CRUD tier (skill §2.3): a small entity guarding the handful of genuine rules (statutory-id
 * format via the shared `Bin`/`Tin` VOs, non-empty name), not a rich aggregate.
 */
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { Bin } from '../../../../common/value-objects/bin';
import { Tin } from '../../../../common/value-objects/tin';
import { IdGenerator } from '../../../../common/ports/id-generator.port';

/** Phase-1 localization defaults (FR-MAS-004). Bangladesh-first. */
export const COMPANY_DEFAULTS = {
  currency: 'BDT',
  dateFormat: 'DD/MM/YYYY',
  locale: 'bn-BD',
} as const;

export interface NewCompany {
  name: string;
  legalName: string;
  bin: string;
  tin: string;
  address?: string | null;
  currency?: string;
  dateFormat?: string;
  locale?: string;
}

export interface CompanyProps {
  name: string;
  legalName: string;
  bin: Bin;
  tin: Tin;
  address: string | null;
  currency: string;
  dateFormat: string;
  locale: string;
  isActive: boolean;
  /** Optimistic-concurrency token (FR-MAS-032); 1 on create, bumped on each persisted change. */
  version: number;
}

export class Company extends Entity<string> {
  private constructor(
    id: string,
    private _props: CompanyProps,
  ) {
    super(id);
  }

  /** Create a brand-new company (version 1, active). Validates statutory ids + required fields. */
  static create(input: NewCompany, ids: IdGenerator): Company {
    return new Company(ids.next(), {
      name: Company.requireText(input.name, 'name'),
      legalName: Company.requireText(input.legalName, 'legalName'),
      bin: Bin.of(input.bin),
      tin: Tin.of(input.tin),
      address: Company.normalizeOptional(input.address),
      currency: (input.currency ?? COMPANY_DEFAULTS.currency).trim(),
      dateFormat: (input.dateFormat ?? COMPANY_DEFAULTS.dateFormat).trim(),
      locale: (input.locale ?? COMPANY_DEFAULTS.locale).trim(),
      isActive: true,
      version: 1,
    });
  }

  /** Rehydrate an existing company from persistence (no validation re-run on trusted data). */
  static rehydrate(id: string, props: CompanyProps): Company {
    return new Company(id, props);
  }

  /** Patch identity fields (FR-MAS-001, FR-MAS-004). Undefined fields are left unchanged. */
  updateIdentity(input: {
    name?: string;
    legalName?: string;
    bin?: string;
    tin?: string;
    address?: string | null;
  }): void {
    if (input.name !== undefined) this._props.name = Company.requireText(input.name, 'name');
    if (input.legalName !== undefined) {
      this._props.legalName = Company.requireText(input.legalName, 'legalName');
    }
    if (input.bin !== undefined) this._props.bin = Bin.of(input.bin);
    if (input.tin !== undefined) this._props.tin = Tin.of(input.tin);
    if (input.address !== undefined) this._props.address = Company.normalizeOptional(input.address);
  }

  /** Replace the localization defaults (FR-MAS-004, `PUT …/localization`). All three required. */
  updateLocalization(input: { currency: string; dateFormat: string; locale: string }): void {
    this._props.currency = Company.requireText(input.currency, 'currency');
    this._props.dateFormat = Company.requireText(input.dateFormat, 'dateFormat');
    this._props.locale = Company.requireText(input.locale, 'locale');
  }

  get props(): Readonly<CompanyProps> {
    return this._props;
  }

  get version(): number {
    return this._props.version;
  }

  private static requireText(value: string, field: string): string {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0) {
      throw new ValidationError(`${field} is required`, { field });
    }
    return trimmed;
  }

  private static normalizeOptional(value: string | null | undefined): string | null {
    if (value == null) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
}
