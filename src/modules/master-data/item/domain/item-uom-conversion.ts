/**
 * ItemUomConversion (MAS, FR-MAS-026) — PURE domain. A simple multiply-to-base factor per alternate
 * unit (`factorToBase > 0`). Upsert on (item, uom). The stored factor is defined relative to the
 * item's `base_uom`, which is why changing the base is rejected once any conversion exists (FR-MAS-034).
 */
import Decimal from 'decimal.js';
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { IdGenerator } from '../../../../common/ports/id-generator.port';

export interface ItemUomConversionProps {
  companyId: string;
  itemId: string;
  uom: string;
  factorToBase: Decimal;
  version: number;
}

export class ItemUomConversion extends Entity<string> {
  private constructor(
    id: string,
    private _props: ItemUomConversionProps,
  ) {
    super(id);
  }

  static create(
    input: { companyId: string; itemId: string; uom: string; factorToBase: string | number },
    ids: IdGenerator,
  ): ItemUomConversion {
    return new ItemUomConversion(ids.next(), {
      companyId: input.companyId,
      itemId: input.itemId,
      uom: req(input.uom, 'uom'),
      factorToBase: factor(input.factorToBase),
      version: 1,
    });
  }

  static rehydrate(id: string, props: ItemUomConversionProps): ItemUomConversion {
    return new ItemUomConversion(id, props);
  }

  setFactor(value: string | number): void {
    this._props.factorToBase = factor(value);
  }

  get props(): Readonly<ItemUomConversionProps> {
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
function factor(value: string | number): Decimal {
  const d = new Decimal(value);
  if (!d.isFinite() || d.lessThanOrEqualTo(0)) {
    throw new ValidationError('factorToBase must be greater than 0', { value });
  }
  return d;
}
