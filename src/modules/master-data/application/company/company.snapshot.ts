/** Plain before/after snapshot of a Company for the audit log (FR-MAS-031). No PII beyond identity. */
import { Company } from '../../company/domain/company';

export function companySnapshot(company: Company): Record<string, unknown> {
  const p = company.props;
  return {
    id: company.id,
    name: p.name,
    legalName: p.legalName,
    bin: p.bin.value,
    tin: p.tin.value,
    address: p.address,
    currency: p.currency,
    dateFormat: p.dateFormat,
    locale: p.locale,
    isActive: p.isActive,
    version: p.version,
  };
}
