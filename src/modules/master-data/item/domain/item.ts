/**
 * Item master (MAS, FR-MAS-025/027/029/033/034) — PURE domain. Company-unique `code`, `base_uom`,
 * `hs_code`, `default_account_id` (posting default consumed by PUR/REQ). `base_uom` is immutable once
 * UoM conversions or stock/transaction references exist (FR-MAS-034) — that guard needs a repo query,
 * so it is enforced in the use case; the aggregate exposes `changeBaseUom`.
 */
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { IdGenerator } from '../../../../common/ports/id-generator.port';

export interface ItemProps {
  companyId: string;
  code: string;
  name: string;
  baseUom: string;
  hsCode: string | null;
  defaultAccountId: string;
  isActive: boolean;
  version: number;
}

export class Item extends Entity<string> {
  private constructor(
    id: string,
    private _props: ItemProps,
  ) {
    super(id);
  }

  static create(
    input: { companyId: string; code: string; name: string; baseUom: string; hsCode?: string | null; defaultAccountId: string },
    ids: IdGenerator,
  ): Item {
    return new Item(ids.next(), {
      companyId: input.companyId,
      code: req(input.code, 'code'),
      name: req(input.name, 'name'),
      baseUom: req(input.baseUom, 'baseUom'),
      hsCode: opt(input.hsCode),
      defaultAccountId: req(input.defaultAccountId, 'defaultAccountId'),
      isActive: true,
      version: 1,
    });
  }

  static rehydrate(id: string, props: ItemProps): Item {
    return new Item(id, props);
  }

  rename(name: string): void {
    this._props.name = req(name, 'name');
  }
  setHsCode(hsCode: string | null): void {
    this._props.hsCode = opt(hsCode);
  }
  setDefaultAccount(defaultAccountId: string): void {
    this._props.defaultAccountId = req(defaultAccountId, 'defaultAccountId');
  }
  /** Change base unit. Immutability (after conversions/transactions) is gated by the use case. */
  changeBaseUom(baseUom: string): void {
    this._props.baseUom = req(baseUom, 'baseUom');
  }
  deactivate(): void {
    this._props.isActive = false;
  }
  reactivate(): void {
    this._props.isActive = true;
  }

  get props(): Readonly<ItemProps> {
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
