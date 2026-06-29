/**
 * Company domain entity unit tests (no DB, no Nest) — FR-MAS-001, FR-MAS-004.
 * Guards: required identity, BIN/TIN format (via shared VOs), localization defaults, version=1.
 */
import { Company } from '../../../src/modules/master-data/company/domain/company';
import { ValidationError } from '../../../src/common/errors/domain-error';
import { IdGenerator } from '../../../src/common/ports/id-generator.port';

const ids: IdGenerator = { next: () => 'company-1' };

const VALID = {
  name: 'Zakir Enterprise',
  legalName: 'Zakir Enterprise Ltd.',
  bin: '1234567890123', // 13 digits
  tin: '123456789012', // 12 digits
};

describe('Company (domain)', () => {
  it('creates with version 1, active, and Bangladesh localization defaults (FR-MAS-004)', () => {
    const c = Company.create(VALID, ids);
    expect(c.id).toBe('company-1');
    expect(c.props.version).toBe(1);
    expect(c.props.isActive).toBe(true);
    expect(c.props.currency).toBe('BDT');
    expect(c.props.dateFormat).toBe('DD/MM/YYYY');
    expect(c.props.locale).toBe('bn-BD');
    expect(c.props.bin.value).toBe('1234567890123');
    expect(c.props.tin.value).toBe('123456789012');
  });

  it('honours supplied localization overrides', () => {
    const c = Company.create({ ...VALID, currency: 'USD', locale: 'en-US' }, ids);
    expect(c.props.currency).toBe('USD');
    expect(c.props.locale).toBe('en-US');
  });

  it('rejects an empty name (FR-MAS-001)', () => {
    expect(() => Company.create({ ...VALID, name: '   ' }, ids)).toThrow(ValidationError);
  });

  it('rejects a malformed BIN/TIN (FR-MAS-004, format-only)', () => {
    expect(() => Company.create({ ...VALID, bin: '12' }, ids)).toThrow(ValidationError);
    expect(() => Company.create({ ...VALID, tin: 'abc' }, ids)).toThrow(ValidationError);
  });

  it('updateLocalization replaces currency/date-format/locale', () => {
    const c = Company.create(VALID, ids);
    c.updateLocalization({ currency: 'EUR', dateFormat: 'YYYY-MM-DD', locale: 'en-GB' });
    expect(c.props.currency).toBe('EUR');
    expect(c.props.dateFormat).toBe('YYYY-MM-DD');
    expect(c.props.locale).toBe('en-GB');
  });

  it('updateIdentity patches only the supplied fields', () => {
    const c = Company.create(VALID, ids);
    c.updateIdentity({ name: 'ZE Renamed' });
    expect(c.props.name).toBe('ZE Renamed');
    expect(c.props.legalName).toBe('Zakir Enterprise Ltd.');
  });

  it('updateIdentity validates a new BIN', () => {
    const c = Company.create(VALID, ids);
    expect(() => c.updateIdentity({ bin: 'not-a-bin' })).toThrow(ValidationError);
  });
});
