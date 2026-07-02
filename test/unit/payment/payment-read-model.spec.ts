/**
 * PAY #28 read-side composition unit tests (fake DataSource.manager.query + fake read model). The raw
 * projection SQL is proven in the int-spec against a real Postgres; here we cover the pure composition the
 * `PaymentQueryService` layers ON TOP of it:
 *   - `openPayables` = originalAmount − applied, excludes fully-settled, respects payableType + PM scoping;
 *   - `appliedToPayable` shape (original/applied/remaining + applications) and 404 when the payable is absent.
 */
import Decimal from 'decimal.js';
import { NotFoundException } from '@nestjs/common';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { PaymentQueryService } from '../../../src/modules/payment/application/payment-query.service';
import { PaymentAllocationReadModel } from '../../../src/modules/payment/infrastructure/payment-allocation.read-model';

const unscoped: Actor = {
  userId: 'u1',
  companyId: 'co1',
  financialYearId: 'fy1',
  role: 'Accounts',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

const scopedNoProjects: Actor = { ...unscoped, isUnscoped: false, assignedProjectIds: [] };
const scopedPm: Actor = { ...unscoped, isUnscoped: false, assignedProjectIds: ['p1'] };

/** A fake DataSource whose `manager.query` routes on SQL substrings to canned rows. */
function fakeDataSource(routes: (sql: string, params: unknown[]) => unknown[]): never {
  const manager = { query: jest.fn(async (sql: string, params: unknown[] = []) => routes(sql, params)) };
  return { manager } as never;
}

function fakeReadModel(over: Partial<PaymentAllocationReadModel>): PaymentAllocationReadModel {
  return {
    appliedTo: async () => new Decimal(0),
    appliedForPayables: async () => new Map(),
    applicationsFor: async () => [],
    ...over,
  } as unknown as PaymentAllocationReadModel;
}

describe('PaymentQueryService.openPayables (composition)', () => {
  it('composes original − applied and excludes fully-settled rows', async () => {
    const ds = fakeDataSource((sql) => {
      if (sql.includes('FROM purchase_bill')) {
        return [
          { id: 'billA', entry_no: 'PB/1', supplier_id: 'sup1', net: '231150.0000', bill_date: '2026-06-15' },
          { id: 'billB', entry_no: 'PB/2', supplier_id: 'sup1', net: '100000.0000', bill_date: '2026-06-10' },
        ];
      }
      return [];
    });
    const readModel = fakeReadModel({
      appliedForPayables: async () =>
        new Map<string, Decimal>([
          ['billA', new Decimal('200000')],
          ['billB', new Decimal('100000')], // fully settled → excluded
        ]),
    });
    const svc = new PaymentQueryService(ds, readModel);

    const page = await svc.openPayables({ payableType: 'PURCHASE_BILL' }, unscoped);
    expect(page.total).toBe(1);
    expect(page.items).toEqual([
      {
        payableType: 'PURCHASE_BILL',
        payableId: 'billA',
        reference: 'PB/1',
        partyId: 'sup1',
        originalAmount: '231150.0000',
        appliedAmount: '200000.0000',
        remainingOutstanding: '31150.0000',
        accruedAmount: null,
        payableDate: '2026-06-15',
      },
    ]);
  });

  it('treats a payable with no posted payment (absent from the map) as fully outstanding', async () => {
    const ds = fakeDataSource((sql) =>
      sql.includes('FROM purchase_bill')
        ? [{ id: 'billA', entry_no: 'PB/1', supplier_id: 'sup1', net: '5000.0000', bill_date: '2026-06-15' }]
        : [],
    );
    const svc = new PaymentQueryService(ds, fakeReadModel({ appliedForPayables: async () => new Map() }));
    const page = await svc.openPayables({ payableType: 'PURCHASE_BILL' }, unscoped);
    expect(page.items[0]).toMatchObject({ appliedAmount: '0.0000', remainingOutstanding: '5000.0000' });
  });

  it('scoped PM with zero assigned projects sees no PURCHASE_BILL payables', async () => {
    const query = jest.fn(async () => []);
    const ds = { manager: { query } } as never;
    const svc = new PaymentQueryService(ds, fakeReadModel({}));
    const page = await svc.openPayables({ payableType: 'PURCHASE_BILL' }, scopedNoProjects);
    expect(page.total).toBe(0);
    expect(query).not.toHaveBeenCalled(); // short-circuits before touching the DB
  });

  it('SALARY payables are excluded for a scoped PM (no project dimension)', async () => {
    const query = jest.fn(async () => []);
    const ds = { manager: { query } } as never;
    const svc = new PaymentQueryService(ds, fakeReadModel({}));
    const page = await svc.openPayables({ payableType: 'SALARY' }, scopedPm);
    expect(page.total).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('PaymentQueryService.appliedToPayable', () => {
  it('returns original/applied/remaining + the applications trail', async () => {
    const ds = fakeDataSource((sql) =>
      sql.includes('FROM purchase_bill') ? [{ net: '231150.0000' }] : [],
    );
    const readModel = fakeReadModel({
      appliedTo: async () => new Decimal('200000'),
      applicationsFor: async () => [
        { paymentId: 'pv1', entryNo: 'PV/1', paymentDate: '2026-06-30', amountAllocated: '200000.0000', status: 'POSTED' },
      ],
    });
    const svc = new PaymentQueryService(ds, readModel);

    const dto = await svc.appliedToPayable('PURCHASE_BILL', 'billA', unscoped);
    expect(dto).toEqual({
      payableType: 'PURCHASE_BILL',
      payableId: 'billA',
      originalAmount: '231150.0000',
      appliedAmount: '200000.0000',
      remainingOutstanding: '31150.0000',
      applications: [
        { paymentId: 'pv1', entryNo: 'PV/1', paymentDate: '2026-06-30', amountAllocated: '200000.0000', status: 'POSTED' },
      ],
    });
  });

  it('404s when the payable does not exist in the company', async () => {
    const ds = fakeDataSource(() => []); // no bill row
    const svc = new PaymentQueryService(ds, fakeReadModel({}));
    await expect(svc.appliedToPayable('PURCHASE_BILL', 'missing', unscoped)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
