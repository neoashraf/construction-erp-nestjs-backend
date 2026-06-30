/**
 * Account + AccountGroup domain unit tests (no DB) — typing (FR-MAS-019), opening-balance reference
 * field (FR-MAS-020), and the exact-Decimal handling of opening balance.
 */
import Decimal from 'decimal.js';
import { Account } from '../../../src/modules/master-data/chart-of-accounts/domain/account';
import { AccountGroup } from '../../../src/modules/master-data/chart-of-accounts/domain/account-group';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';

const ids = (id: string): IdGenerator => ({ next: () => id });

describe('AccountGroup (domain)', () => {
  it('creates typed at version 1; rejects a bad type and an empty name', () => {
    const g = AccountGroup.create({ companyId: 'co-1', name: 'Assets', type: 'ASSET' }, ids('g-1'));
    expect(g.props.type).toBe('ASSET');
    expect(g.props.parentGroupId).toBeNull();
    expect(g.version).toBe(1);
    expect(() => AccountGroup.create({ companyId: 'co-1', name: 'X', type: 'NONSENSE' }, ids('g-2'))).toThrow(ValidationError);
    expect(() => AccountGroup.create({ companyId: 'co-1', name: '  ', type: 'ASSET' }, ids('g-3'))).toThrow(ValidationError);
  });

  it('rejects self-parenting on update', () => {
    const g = AccountGroup.create({ companyId: 'co-1', name: 'Assets', type: 'ASSET' }, ids('g-1'));
    expect(() => g.update({ parentGroupId: 'g-1' })).toThrow(ValidationError);
  });
});

describe('Account (domain)', () => {
  const BASE = { companyId: 'co-1', code: '1100', name: 'Cash', accountGroupId: 'g-1', type: 'ASSET' };

  it('creates active at version 1, typed, with a null opening balance by default', () => {
    const a = Account.create(BASE, ids('a-1'));
    expect(a.props.isActive).toBe(true);
    expect(a.props.type).toBe('ASSET');
    expect(a.props.openingBalance).toBeNull();
    expect(a.version).toBe(1);
  });

  it('parses opening balance as an exact Decimal (FR-MAS-020)', () => {
    const a = Account.create({ ...BASE, openingBalance: '1500.5000' }, ids('a-1'));
    expect(a.props.openingBalance).toBeInstanceOf(Decimal);
    expect(a.props.openingBalance?.toFixed(4)).toBe('1500.5000');
    a.setOpeningBalance(null);
    expect(a.props.openingBalance).toBeNull();
  });

  it('rejects an invalid type and an empty code', () => {
    expect(() => Account.create({ ...BASE, type: 'BOGUS' }, ids('a-1'))).toThrow(ValidationError);
    expect(() => Account.create({ ...BASE, code: '' }, ids('a-1'))).toThrow(ValidationError);
  });

  it('changeType validates the new type', () => {
    const a = Account.create(BASE, ids('a-1'));
    a.changeType('EXPENSE');
    expect(a.props.type).toBe('EXPENSE');
    expect(() => a.changeType('NOPE')).toThrow(ValidationError);
  });
});
