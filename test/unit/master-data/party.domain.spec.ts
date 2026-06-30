/**
 * Party domain unit tests (no DB) — multi-role requirement (FR-MAS-022), field validation
 * (phone E.164, TIN/BIN, email, opening balance >= 0 — FR-MAS-023).
 */
import { Party } from '../../../src/modules/master-data/party/domain/party';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';

const ids: IdGenerator = { next: () => 'party-1' };
const BASE = { companyId: 'co-1', name: 'Acme Builders', isCustomer: true, phone: '+8801712345678' };

describe('Party (domain)', () => {
  it('creates an active, versioned party with at least one role', () => {
    const p = Party.create({ ...BASE, isSupplier: true }, ids);
    expect(p.props.isActive).toBe(true);
    expect(p.props.isCustomer).toBe(true);
    expect(p.props.isSupplier).toBe(true);
    expect(p.version).toBe(1);
  });

  it('rejects a party with neither role flag (FR-MAS-022)', () => {
    expect(() => Party.create({ companyId: 'co-1', name: 'X', phone: '+8801712345678' }, ids)).toThrow(ValidationError);
    expect(() => Party.create({ ...BASE, isCustomer: false, isSupplier: false }, ids)).toThrow(ValidationError);
  });

  it('rejects clearing the last role on update', () => {
    const p = Party.create(BASE, ids);
    expect(() => p.update({ isCustomer: false })).toThrow(ValidationError);
  });

  it('validates phone (E.164), TIN, BIN, email and opening balance (FR-MAS-023)', () => {
    expect(() => Party.create({ ...BASE, phone: '01712345678' }, ids)).toThrow(ValidationError);
    expect(() => Party.create({ ...BASE, tin: '123' }, ids)).toThrow(ValidationError);
    expect(() => Party.create({ ...BASE, bin: 'abc' }, ids)).toThrow(ValidationError);
    expect(() => Party.create({ ...BASE, email: 'not-an-email' }, ids)).toThrow(ValidationError);
    expect(() => Party.create({ ...BASE, openingBalance: '-1' }, ids)).toThrow(ValidationError);
  });

  it('accepts a valid TIN/BIN and exact opening balance', () => {
    const p = Party.create({ ...BASE, tin: '123456789012', bin: '1234567890123', openingBalance: '250.0000' }, ids);
    expect(p.props.tin).toBe('123456789012');
    expect(p.props.bin).toBe('1234567890123');
    expect(p.props.openingBalance?.toFixed(4)).toBe('250.0000');
  });
});
