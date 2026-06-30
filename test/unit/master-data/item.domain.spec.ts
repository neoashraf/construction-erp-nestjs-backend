/**
 * Item + ItemUomConversion domain unit tests (no DB) — required fields (FR-MAS-025), the
 * factor-to-base `> 0` rule (FR-MAS-026), and base-uom mutator (immutability gate lives in the use case).
 */
import { Item } from '../../../src/modules/master-data/item/domain/item';
import { ItemUomConversion } from '../../../src/modules/master-data/item/domain/item-uom-conversion';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';

const ids: IdGenerator = { next: () => 'item-1' };
const BASE = { companyId: 'co-1', code: 'CEM-50', name: 'Cement 50kg', baseUom: 'BAG', defaultAccountId: 'acc-1' };

describe('Item (domain)', () => {
  it('creates active, versioned, with optional hs code', () => {
    const i = Item.create({ ...BASE, hsCode: '2523.29' }, ids);
    expect(i.props.isActive).toBe(true);
    expect(i.props.baseUom).toBe('BAG');
    expect(i.props.hsCode).toBe('2523.29');
    expect(i.version).toBe(1);
  });

  it('rejects empty code / name / baseUom / defaultAccountId', () => {
    expect(() => Item.create({ ...BASE, code: '' }, ids)).toThrow(ValidationError);
    expect(() => Item.create({ ...BASE, name: '  ' }, ids)).toThrow(ValidationError);
    expect(() => Item.create({ ...BASE, baseUom: '' }, ids)).toThrow(ValidationError);
    expect(() => Item.create({ ...BASE, defaultAccountId: '' }, ids)).toThrow(ValidationError);
  });

  it('changeBaseUom updates the base unit', () => {
    const i = Item.create(BASE, ids);
    i.changeBaseUom('KG');
    expect(i.props.baseUom).toBe('KG');
  });
});

describe('ItemUomConversion (domain)', () => {
  const C = { companyId: 'co-1', itemId: 'item-1', uom: 'TON', factorToBase: '1000' };

  it('creates with an exact factor and rejects factor <= 0 (FR-MAS-026)', () => {
    const c = ItemUomConversion.create(C, ids);
    expect(c.props.factorToBase.toFixed(4)).toBe('1000.0000');
    expect(() => ItemUomConversion.create({ ...C, factorToBase: '0' }, ids)).toThrow(ValidationError);
    expect(() => ItemUomConversion.create({ ...C, factorToBase: '-5' }, ids)).toThrow(ValidationError);
  });

  it('setFactor re-validates', () => {
    const c = ItemUomConversion.create(C, ids);
    c.setFactor('500.25');
    expect(c.props.factorToBase.toFixed(4)).toBe('500.2500');
    expect(() => c.setFactor('0')).toThrow(ValidationError);
  });
});
