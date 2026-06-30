/**
 * ProjectBudget master (MAS, FR-MAS-007/008) — PURE domain. A budgeted amount per (project, cost
 * centre) pair; non-negative money. Upsert is keyed on the pair (one row per pair).
 */
import Decimal from 'decimal.js';
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { Money } from '../../../../common/money';
import { IdGenerator } from '../../../../common/ports/id-generator.port';

export interface ProjectBudgetProps {
  companyId: string;
  projectId: string;
  costCentreId: string;
  budgetedAmount: Money;
  version: number;
}

export class ProjectBudget extends Entity<string> {
  private constructor(
    id: string,
    private _props: ProjectBudgetProps,
  ) {
    super(id);
  }

  static create(
    input: { companyId: string; projectId: string; costCentreId: string; budgetedAmount: string },
    ids: IdGenerator,
  ): ProjectBudget {
    return new ProjectBudget(ids.next(), {
      companyId: input.companyId,
      projectId: input.projectId,
      costCentreId: input.costCentreId,
      budgetedAmount: nonNegative(input.budgetedAmount),
      version: 1,
    });
  }

  static rehydrate(id: string, props: ProjectBudgetProps): ProjectBudget {
    return new ProjectBudget(id, props);
  }

  setAmount(amount: string): void {
    this._props.budgetedAmount = nonNegative(amount);
  }

  get props(): Readonly<ProjectBudgetProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }
}

function nonNegative(raw: string): Money {
  const d = new Decimal(raw);
  if (d.isNegative()) throw new ValidationError('budgeted_amount must be >= 0', { value: raw });
  return Money.of(d);
}
