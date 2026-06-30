/**
 * Godown master (MAS, FR-MAS-014/016) — PURE domain. Belongs to exactly one project; unique name per
 * project; create/update/deactivate/reactivate (deactivate-not-delete).
 */
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { IdGenerator } from '../../../../common/ports/id-generator.port';

export interface GodownProps {
  companyId: string;
  projectId: string;
  name: string;
  location: string | null;
  isActive: boolean;
  version: number;
}

export class Godown extends Entity<string> {
  private constructor(
    id: string,
    private _props: GodownProps,
  ) {
    super(id);
  }

  static create(
    input: { companyId: string; projectId: string; name: string; location?: string | null },
    ids: IdGenerator,
  ): Godown {
    return new Godown(ids.next(), {
      companyId: input.companyId,
      projectId: input.projectId,
      name: req(input.name, 'name'),
      location: opt(input.location),
      isActive: true,
      version: 1,
    });
  }

  static rehydrate(id: string, props: GodownProps): Godown {
    return new Godown(id, props);
  }

  update(input: { name?: string; location?: string | null }): void {
    if (input.name !== undefined) this._props.name = req(input.name, 'name');
    if (input.location !== undefined) this._props.location = opt(input.location);
  }
  deactivate(): void {
    this._props.isActive = false;
  }
  reactivate(): void {
    this._props.isActive = true;
  }

  get props(): Readonly<GodownProps> {
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
function opt(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
}
