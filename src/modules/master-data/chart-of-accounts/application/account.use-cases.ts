/**
 * Account use cases (FR-MAS-018/019/020/021/029/033). Create / update / deactivate / reactivate.
 * Enforces:
 *   - `type == group.type` on create + update (ACCOUNT_TYPE_MISMATCH, FR-MAS-019);
 *   - cross-company group reference rejected (CROSS_COMPANY_REFERENCE, FR-MAS-028);
 *   - `type` immutable once the account has ledger postings (ACCOUNT_TYPE_IMMUTABLE, FR-MAS-021),
 *     determined via the LED has-postings SEAM (`LEDGER_POSTINGS_QUERY`).
 * `openingBalance` is reference data only — never posted here (FR-MAS-020). Audit on every mutation.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  AccountTypeImmutableError,
  AccountTypeMismatchError,
  CrossCompanyReferenceError,
  NotFoundError,
} from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService, AuditAction } from '../../../../core/audit/application/audit.port';
import { assertVersion } from '../../application/optimistic-lock';
import { assertAccountType } from '../domain/account-type';
import { Account } from '../domain/account';
import { TypeOrmAccountRepository } from '../infrastructure/typeorm-account.repository';
import { TypeOrmAccountGroupRepository } from '../infrastructure/typeorm-account-group.repository';
import { LEDGER_POSTINGS_QUERY, LedgerPostingsQuery } from '../domain/ports/ledger-postings.port';

export interface CreateAccountInput {
  code: string;
  name: string;
  accountGroupId: string;
  type: string;
  openingBalance?: string | number | null;
}

@Injectable()
export class CreateAccountUseCase {
  constructor(
    private readonly repo: TypeOrmAccountRepository,
    private readonly groups: TypeOrmAccountGroupRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  async execute(input: CreateAccountInput, actor: Actor): Promise<{ id: string }> {
    return this.uow.run(async () => {
      const groupType = await this.groups.typeOf(input.accountGroupId, actor.companyId);
      if (!groupType) {
        throw new CrossCompanyReferenceError('account group does not belong to the company', {
          accountGroupId: input.accountGroupId,
        });
      }
      if (assertAccountType(input.type) !== groupType) throw new AccountTypeMismatchError(input.type, groupType);
      const account = Account.create({ companyId: actor.companyId, ...input }, this.ids);
      await this.repo.insert(account);
      await rec(this.audit, 'CREATE', account.id, actor);
      return { id: account.id };
    });
  }
}

export interface UpdateAccountInput {
  name?: string;
  accountGroupId?: string;
  type?: string;
  openingBalance?: string | number | null;
}

@Injectable()
export class UpdateAccountUseCase {
  constructor(
    private readonly repo: TypeOrmAccountRepository,
    private readonly groups: TypeOrmAccountGroupRepository,
    @Inject(LEDGER_POSTINGS_QUERY) private readonly ledger: LedgerPostingsQuery,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  async execute(id: string, input: UpdateAccountInput, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const account = await this.repo.findById(id, actor.companyId);
      if (!account) throw new NotFoundError(`Account ${id} not found`);
      assertVersion(account.version, version, 'Account', id);

      // FR-MAS-021: a type change is rejected once the account has any ledger posting.
      const typeChanged = input.type !== undefined && assertAccountType(input.type) !== account.props.type;
      if (typeChanged && (await this.ledger.hasPostings(id, actor.companyId))) {
        throw new AccountTypeImmutableError();
      }

      if (input.name !== undefined) account.rename(input.name);
      if (input.openingBalance !== undefined) account.setOpeningBalance(input.openingBalance);
      if (input.accountGroupId !== undefined) account.reassignGroup(input.accountGroupId);
      if (input.type !== undefined) account.changeType(input.type);

      // FR-MAS-019 + FR-MAS-028: effective type must equal the effective group's type (same company).
      const groupType = await this.groups.typeOf(account.props.accountGroupId, actor.companyId);
      if (!groupType) {
        throw new CrossCompanyReferenceError('account group does not belong to the company', {
          accountGroupId: account.props.accountGroupId,
        });
      }
      if (account.props.type !== groupType) throw new AccountTypeMismatchError(account.props.type, groupType);

      await this.repo.update(account, version);
      await rec(this.audit, 'UPDATE', id, actor);
    });
  }
}

abstract class ToggleAccount {
  constructor(
    protected readonly repo: TypeOrmAccountRepository,
    @Inject(AUDIT_SERVICE) protected readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) protected readonly uow: UnitOfWork,
  ) {}
  protected async toggle(id: string, version: number, actor: Actor, active: boolean, action: AuditAction): Promise<void> {
    await this.uow.run(async () => {
      const account = await this.repo.findById(id, actor.companyId);
      if (!account) throw new NotFoundError(`Account ${id} not found`);
      assertVersion(account.version, version, 'Account', id);
      if (active) account.reactivate();
      else account.deactivate();
      await this.repo.update(account, version);
      await rec(this.audit, action, id, actor);
    });
  }
}

@Injectable()
export class DeactivateAccountUseCase extends ToggleAccount {
  execute(id: string, version: number, actor: Actor): Promise<void> {
    return this.toggle(id, version, actor, false, 'DEACTIVATE');
  }
}

@Injectable()
export class ReactivateAccountUseCase extends ToggleAccount {
  execute(id: string, version: number, actor: Actor): Promise<void> {
    return this.toggle(id, version, actor, true, 'REACTIVATE');
  }
}

function rec(audit: AuditService, action: AuditAction, id: string, actor: Actor): Promise<void> {
  return audit.record({ action, entityType: 'Account', entityId: id, actorId: actor.userId, companyId: actor.companyId });
}
