/** AccountingPeriod response DTO + mapper (camelCase, overview §6). Shared by use cases + read service. */
import { AccountingPeriod } from '../domain/accounting-period';

export interface AccountingPeriodDto {
  id: string;
  financialYearId: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
  closedAt: string | null;
  closedBy: string | null;
}

export function toPeriodDto(p: AccountingPeriod): AccountingPeriodDto {
  const props = p.props;
  return {
    id: p.id,
    financialYearId: props.financialYearId,
    name: props.name,
    startDate: props.startDate.value,
    endDate: props.endDate.value,
    status: props.status,
    closedAt: props.closedAt ? props.closedAt.toISOString() : null,
    closedBy: props.closedBy,
  };
}
