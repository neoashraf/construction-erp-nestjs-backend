/** TypeOrmPartyRepository (INFRASTRUCTURE) — company-scoped, version-guarded. */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../../database/database.module';
import { getManager } from '../../../../infrastructure/unit-of-work/transaction-context';
import { versionedUpdate } from '../../shared/repo-helpers';
import { Party } from '../domain/party';
import { PartyOrmEntity } from './party.orm-entity';

@Injectable()
export class TypeOrmPartyRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}
  private repo() {
    return getManager(this.dataSource).getRepository(PartyOrmEntity);
  }

  async findById(id: string, companyId: string): Promise<Party | null> {
    const r = await this.repo().findOne({ where: { id, companyId } });
    return r ? toDomain(r) : null;
  }

  async insert(party: Party): Promise<void> {
    const p = party.props;
    await this.repo().insert({
      id: party.id,
      companyId: p.companyId,
      name: p.name,
      isCustomer: p.isCustomer,
      isSupplier: p.isSupplier,
      tin: p.tin,
      bin: p.bin,
      address: p.address,
      phone: p.phone,
      email: p.email,
      paymentTermsDays: p.paymentTermsDays,
      openingBalance: p.openingBalance,
      isActive: p.isActive,
    });
  }

  async update(party: Party, expectedVersion: number): Promise<void> {
    const p = party.props;
    await versionedUpdate(this.repo(), PartyOrmEntity, party.id, p.companyId, expectedVersion, {
      name: p.name,
      isCustomer: p.isCustomer,
      isSupplier: p.isSupplier,
      tin: p.tin,
      bin: p.bin,
      address: p.address,
      phone: p.phone,
      email: p.email,
      paymentTermsDays: p.paymentTermsDays,
      openingBalance: p.openingBalance,
      isActive: p.isActive,
    });
  }
}

function toDomain(r: PartyOrmEntity): Party {
  return Party.rehydrate(r.id, {
    companyId: r.companyId,
    name: r.name,
    isCustomer: r.isCustomer,
    isSupplier: r.isSupplier,
    tin: r.tin,
    bin: r.bin,
    address: r.address,
    phone: r.phone,
    email: r.email,
    paymentTermsDays: r.paymentTermsDays,
    openingBalance: r.openingBalance,
    isActive: r.isActive,
    version: r.version,
  });
}
