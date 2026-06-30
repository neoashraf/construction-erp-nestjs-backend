/**
 * Item use cases (FR-MAS-025/027/029/033/034). Create / update / deactivate / reactivate +
 * ItemUomConversion upsert / delete (FR-MAS-026). Enforces:
 *   - cross-company `defaultAccountId` rejected (CROSS_COMPANY_REFERENCE, FR-MAS-027/028);
 *   - `base_uom` immutable once UoM conversions / stock references exist (BASE_UOM_IMMUTABLE, FR-MAS-034).
 * Audit on every mutation.
 */
import { Inject, Injectable } from '@nestjs/common';
import { BaseUomImmutableError, CrossCompanyReferenceError, NotFoundError } from '../../../../common/errors/domain-error';
import { UNIT_OF_WORK, UnitOfWork } from '../../../../common/ports/unit-of-work.port';
import { ID_GENERATOR, IdGenerator } from '../../../../common/ports/id-generator.port';
import { Actor } from '../../../../core/tenancy/tenant-context';
import { AUDIT_SERVICE, AuditService, AuditAction } from '../../../../core/audit/application/audit.port';
import { assertVersion } from '../../application/optimistic-lock';
import { TypeOrmAccountRepository } from '../../chart-of-accounts/infrastructure/typeorm-account.repository';
import { Item } from '../domain/item';
import { ItemUomConversion } from '../domain/item-uom-conversion';
import { TypeOrmItemRepository } from '../infrastructure/typeorm-item.repository';
import { TypeOrmItemUomConversionRepository } from '../infrastructure/typeorm-item-uom-conversion.repository';

export interface CreateItemInput {
  code: string;
  name: string;
  baseUom: string;
  hsCode?: string | null;
  defaultAccountId: string;
}

@Injectable()
export class CreateItemUseCase {
  constructor(
    private readonly repo: TypeOrmItemRepository,
    private readonly accounts: TypeOrmAccountRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  async execute(input: CreateItemInput, actor: Actor): Promise<{ id: string }> {
    return this.uow.run(async () => {
      await this.assertAccountInCompany(input.defaultAccountId, actor);
      const item = Item.create({ companyId: actor.companyId, ...input }, this.ids);
      await this.repo.insert(item);
      await rec(this.audit, 'CREATE', 'Item', item.id, actor);
      return { id: item.id };
    });
  }

  private async assertAccountInCompany(accountId: string, actor: Actor): Promise<void> {
    if (!(await this.accounts.existsInCompany(accountId, actor.companyId))) {
      throw new CrossCompanyReferenceError('default account does not belong to the company', { accountId });
    }
  }
}

export interface UpdateItemInput {
  name?: string;
  baseUom?: string;
  hsCode?: string | null;
  defaultAccountId?: string;
}

@Injectable()
export class UpdateItemUseCase {
  constructor(
    private readonly repo: TypeOrmItemRepository,
    private readonly accounts: TypeOrmAccountRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  async execute(id: string, input: UpdateItemInput, version: number, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const item = await this.repo.findById(id, actor.companyId);
      if (!item) throw new NotFoundError(`Item ${id} not found`);
      assertVersion(item.version, version, 'Item', id);

      // FR-MAS-034: base_uom is immutable once conversions / stock references exist.
      const baseUomChanged = input.baseUom !== undefined && input.baseUom.trim() !== item.props.baseUom;
      if (baseUomChanged && (await this.repo.hasBaseUomReferences(id))) throw new BaseUomImmutableError();

      if (input.defaultAccountId !== undefined && !(await this.accounts.existsInCompany(input.defaultAccountId, actor.companyId))) {
        throw new CrossCompanyReferenceError('default account does not belong to the company', {
          accountId: input.defaultAccountId,
        });
      }

      if (input.name !== undefined) item.rename(input.name);
      if (input.hsCode !== undefined) item.setHsCode(input.hsCode);
      if (input.defaultAccountId !== undefined) item.setDefaultAccount(input.defaultAccountId);
      if (input.baseUom !== undefined) item.changeBaseUom(input.baseUom);

      await this.repo.update(item, version);
      await rec(this.audit, 'UPDATE', 'Item', id, actor);
    });
  }
}

abstract class ToggleItem {
  constructor(
    protected readonly repo: TypeOrmItemRepository,
    @Inject(AUDIT_SERVICE) protected readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) protected readonly uow: UnitOfWork,
  ) {}
  protected async toggle(id: string, version: number, actor: Actor, active: boolean, action: AuditAction): Promise<void> {
    await this.uow.run(async () => {
      const item = await this.repo.findById(id, actor.companyId);
      if (!item) throw new NotFoundError(`Item ${id} not found`);
      assertVersion(item.version, version, 'Item', id);
      if (active) item.reactivate();
      else item.deactivate();
      await this.repo.update(item, version);
      await rec(this.audit, action, 'Item', id, actor);
    });
  }
}

@Injectable()
export class DeactivateItemUseCase extends ToggleItem {
  execute(id: string, version: number, actor: Actor): Promise<void> {
    return this.toggle(id, version, actor, false, 'DEACTIVATE');
  }
}

@Injectable()
export class ReactivateItemUseCase extends ToggleItem {
  execute(id: string, version: number, actor: Actor): Promise<void> {
    return this.toggle(id, version, actor, true, 'REACTIVATE');
  }
}

@Injectable()
export class UpsertItemUomConversionUseCase {
  constructor(
    private readonly items: TypeOrmItemRepository,
    private readonly conversions: TypeOrmItemUomConversionRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}
  /** Upsert on (item, uom): create when absent, otherwise update the factor (FR-MAS-026). */
  async execute(itemId: string, input: { uom: string; factorToBase: string }, actor: Actor): Promise<{ id: string }> {
    return this.uow.run(async () => {
      const item = await this.items.findById(itemId, actor.companyId);
      if (!item) throw new NotFoundError(`Item ${itemId} not found`);
      const existing = await this.conversions.findByItemAndUom(itemId, input.uom.trim(), actor.companyId);
      if (existing) {
        existing.setFactor(input.factorToBase);
        await this.conversions.update(existing, existing.version);
        await rec(this.audit, 'UPDATE', 'ItemUomConversion', existing.id, actor);
        return { id: existing.id };
      }
      const conversion = ItemUomConversion.create({ companyId: actor.companyId, itemId, ...input }, this.ids);
      await this.conversions.insert(conversion);
      await rec(this.audit, 'CREATE', 'ItemUomConversion', conversion.id, actor);
      return { id: conversion.id };
    });
  }
}

@Injectable()
export class DeleteItemUomConversionUseCase {
  constructor(
    private readonly items: TypeOrmItemRepository,
    private readonly conversions: TypeOrmItemUomConversionRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}
  async execute(itemId: string, id: string, actor: Actor): Promise<void> {
    await this.uow.run(async () => {
      const item = await this.items.findById(itemId, actor.companyId);
      if (!item) throw new NotFoundError(`Item ${itemId} not found`);
      const removed = await this.conversions.delete(id, itemId, actor.companyId);
      if (!removed) throw new NotFoundError(`UoM conversion ${id} not found`);
      await rec(this.audit, 'DEACTIVATE', 'ItemUomConversion', id, actor);
    });
  }
}

function rec(audit: AuditService, action: AuditAction, entityType: string, id: string, actor: Actor): Promise<void> {
  return audit.record({ action, entityType, entityId: id, actorId: actor.userId, companyId: actor.companyId });
}
