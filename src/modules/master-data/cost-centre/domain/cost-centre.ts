/**
 * CostCentre master (MAS, FR-MAS-009/010) — PURE domain. Company-global; create/rename/deactivate/
 * reactivate. Company-unique `code`.
 */
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { IdGenerator } from '../../../../common/ports/id-generator.port';

export interface CostCentreProps {
  companyId: string;
  code: string;
  name: string;
  isActive: boolean;
  version: number;
}

export class CostCentre extends Entity<string> {
  private constructor(
    id: string,
    private _props: CostCentreProps,
  ) {
    super(id);
  }

  static create(input: { companyId: string; code: string; name: string }, ids: IdGenerator): CostCentre {
    return new CostCentre(ids.next(), {
      companyId: input.companyId,
      code: req(input.code, 'code'),
      name: req(input.name, 'name'),
      isActive: true,
      version: 1,
    });
  }

  /** Construct with an explicit id (used by the idempotent standard-14 seed). */
  static seed(id: string, input: { companyId: string; code: string; name: string }): CostCentre {
    return new CostCentre(id, {
      companyId: input.companyId,
      code: input.code,
      name: input.name,
      isActive: true,
      version: 1,
    });
  }

  static rehydrate(id: string, props: CostCentreProps): CostCentre {
    return new CostCentre(id, props);
  }

  rename(name: string): void {
    this._props.name = req(name, 'name');
  }
  deactivate(): void {
    this._props.isActive = false;
  }
  reactivate(): void {
    this._props.isActive = true;
  }

  get props(): Readonly<CostCentreProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}
