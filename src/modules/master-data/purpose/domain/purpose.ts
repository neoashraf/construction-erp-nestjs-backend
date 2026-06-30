/**
 * Purpose master (MAS, FR-MAS-011/012/013) — PURE domain. Project-scoped; inline-creatable; unique per
 * project case-insensitive (the `(project_id, lower(name))` index is the race-safe backstop).
 */
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { IdGenerator } from '../../../../common/ports/id-generator.port';

export interface PurposeProps {
  companyId: string;
  projectId: string;
  name: string;
  isActive: boolean;
  version: number;
}

export class Purpose extends Entity<string> {
  private constructor(
    id: string,
    private _props: PurposeProps,
  ) {
    super(id);
  }

  static create(input: { companyId: string; projectId: string; name: string }, ids: IdGenerator): Purpose {
    return new Purpose(ids.next(), {
      companyId: input.companyId,
      projectId: input.projectId,
      name: reqName(input.name),
      isActive: true,
      version: 1,
    });
  }

  static rehydrate(id: string, props: PurposeProps): Purpose {
    return new Purpose(id, props);
  }

  rename(name: string): void {
    this._props.name = reqName(name);
  }
  deactivate(): void {
    this._props.isActive = false;
  }
  reactivate(): void {
    this._props.isActive = true;
  }

  get props(): Readonly<PurposeProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }
}

/** Trimmed, non-empty (case-insensitive dedupe is applied at the repository/use-case layer). */
export function reqName(v: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError('name is required', { field: 'name' });
  return t;
}
