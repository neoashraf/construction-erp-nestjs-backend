/**
 * Party master (Customer/Supplier) (MAS, FR-MAS-022/023/024/029/033) — PURE domain. Multi-role
 * (at least one of is_customer / is_supplier). Validates phone (E.164), TIN/BIN, opening_balance
 * (>= 0, reference only — realised by the GEN opening journal, never posted by MAS).
 */
import Decimal from 'decimal.js';
import { Entity } from '../../../../common/domain/domain';
import { ValidationError } from '../../../../common/errors/domain-error';
import { IdGenerator } from '../../../../common/ports/id-generator.port';
import { PhoneNumber } from '../../../../common/value-objects/phone-number';
import { Tin } from '../../../../common/value-objects/tin';
import { Bin } from '../../../../common/value-objects/bin';

export interface PartyProps {
  companyId: string;
  name: string;
  isCustomer: boolean;
  isSupplier: boolean;
  tin: string | null;
  bin: string | null;
  address: string | null;
  phone: string;
  email: string | null;
  paymentTermsDays: number;
  openingBalance: Decimal | null;
  isActive: boolean;
  version: number;
}

export interface NewPartyInput {
  companyId: string;
  name: string;
  isCustomer?: boolean;
  isSupplier?: boolean;
  tin?: string | null;
  bin?: string | null;
  address?: string | null;
  phone: string;
  email?: string | null;
  paymentTermsDays?: number | null;
  openingBalance?: string | number | null;
}

export class Party extends Entity<string> {
  private constructor(
    id: string,
    private _props: PartyProps,
  ) {
    super(id);
  }

  static create(input: NewPartyInput, ids: IdGenerator): Party {
    const isCustomer = input.isCustomer ?? false;
    const isSupplier = input.isSupplier ?? false;
    assertAtLeastOneRole(isCustomer, isSupplier);
    return new Party(ids.next(), {
      companyId: input.companyId,
      name: req(input.name, 'name'),
      isCustomer,
      isSupplier,
      tin: tinOf(input.tin),
      bin: binOf(input.bin),
      address: opt(input.address),
      phone: phoneOf(input.phone),
      email: emailOf(input.email),
      paymentTermsDays: termsOf(input.paymentTermsDays),
      openingBalance: balanceOf(input.openingBalance),
      isActive: true,
      version: 1,
    });
  }

  static rehydrate(id: string, props: PartyProps): Party {
    return new Party(id, props);
  }

  update(input: Partial<Omit<NewPartyInput, 'companyId'>>): void {
    const p = this._props;
    const isCustomer = input.isCustomer ?? p.isCustomer;
    const isSupplier = input.isSupplier ?? p.isSupplier;
    assertAtLeastOneRole(isCustomer, isSupplier);
    if (input.name !== undefined) p.name = req(input.name, 'name');
    p.isCustomer = isCustomer;
    p.isSupplier = isSupplier;
    if (input.tin !== undefined) p.tin = tinOf(input.tin);
    if (input.bin !== undefined) p.bin = binOf(input.bin);
    if (input.address !== undefined) p.address = opt(input.address);
    if (input.phone !== undefined) p.phone = phoneOf(input.phone);
    if (input.email !== undefined) p.email = emailOf(input.email);
    if (input.paymentTermsDays !== undefined) p.paymentTermsDays = termsOf(input.paymentTermsDays);
    if (input.openingBalance !== undefined) p.openingBalance = balanceOf(input.openingBalance);
  }

  deactivate(): void {
    this._props.isActive = false;
  }
  reactivate(): void {
    this._props.isActive = true;
  }

  get props(): Readonly<PartyProps> {
    return this._props;
  }
  get version(): number {
    return this._props.version;
  }
}

function assertAtLeastOneRole(isCustomer: boolean, isSupplier: boolean): void {
  if (!isCustomer && !isSupplier) {
    throw new ValidationError('A party must be a customer, a supplier, or both', {
      field: 'isCustomer/isSupplier',
    });
  }
}

function req(v: string, field: string): string {
  const t = (v ?? '').trim();
  if (!t) throw new ValidationError(`${field} is required`, { field });
  return t;
}
function opt(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
}
function tinOf(v: string | null | undefined): string | null {
  const t = opt(v);
  return t === null ? null : Tin.of(t).value;
}
function binOf(v: string | null | undefined): string | null {
  const t = opt(v);
  return t === null ? null : Bin.of(t).value;
}
function phoneOf(v: string): string {
  return PhoneNumber.of(req(v, 'phone')).value;
}
function emailOf(v: string | null | undefined): string | null {
  const t = opt(v);
  if (t === null) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) throw new ValidationError(`Invalid email: '${t}'`, { value: t });
  return t;
}
function termsOf(v: number | null | undefined): number {
  const n = v ?? 0;
  if (!Number.isInteger(n) || n < 0) throw new ValidationError('paymentTermsDays must be a non-negative integer', { value: v });
  return n;
}
function balanceOf(v: string | number | null | undefined): Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Decimal(v);
  if (!d.isFinite()) throw new ValidationError('openingBalance must be a finite number', { value: v });
  if (d.isNegative()) throw new ValidationError('openingBalance must be >= 0', { value: v });
  return d;
}
