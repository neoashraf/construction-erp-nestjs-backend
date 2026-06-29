/** Maps Company (domain) ↔ CompanyOrmEntity (persistence). INFRASTRUCTURE. */
import { Bin } from '../../../../../common/value-objects/bin';
import { Tin } from '../../../../../common/value-objects/tin';
import { Company } from '../../domain/company';
import { CompanyOrmEntity } from './company.orm-entity';

export const CompanyMapper = {
  toDomain(row: CompanyOrmEntity): Company {
    return Company.rehydrate(row.id, {
      name: row.name,
      legalName: row.legalName,
      bin: Bin.of(row.bin),
      tin: Tin.of(row.tin),
      address: row.address,
      currency: row.currency,
      dateFormat: row.dateFormat,
      locale: row.locale,
      isActive: row.isActive,
      version: row.version,
    });
  },

  /** Full row for INSERT (new company); version/timestamps are managed by TypeORM. */
  toInsert(company: Company): CompanyOrmEntity {
    const p = company.props;
    const row = new CompanyOrmEntity();
    row.id = company.id;
    row.name = p.name;
    row.legalName = p.legalName;
    row.bin = p.bin.value;
    row.tin = p.tin.value;
    row.address = p.address;
    row.currency = p.currency;
    row.dateFormat = p.dateFormat;
    row.locale = p.locale;
    row.isActive = p.isActive;
    return row;
  },

  /** Mutable columns for an UPDATE …set (version bump + updated_at are added by the repository). */
  toUpdateSet(company: Company): Record<string, unknown> {
    const p = company.props;
    return {
      name: p.name,
      legalName: p.legalName,
      bin: p.bin.value,
      tin: p.tin.value,
      address: p.address,
      currency: p.currency,
      dateFormat: p.dateFormat,
      locale: p.locale,
      isActive: p.isActive,
    };
  },
};
