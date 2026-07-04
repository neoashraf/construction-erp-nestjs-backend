/**
 * TileCatalog integrity (DSH · FR-DSH-001/-002/-006) — PURE, no DB. Proves the seven Phase-1 tiles exist,
 * each drills into a REGISTERED RPT report (FR-DSH-002), keys are unique, every tile carries a source /
 * requiredPermission / projectScoped flag / non-empty roles, and role→tile visibility matches overview §2.
 */
import { TILE_CATALOG, findTile } from '../../../src/dashboard/domain/tile-catalog';
import { REPORT_CATALOG } from '../../../src/reports/domain/report-catalog';

const EXPECTED_KEYS = [
  'project-cash-flow',
  'pending-ipcs',
  'retention-held',
  'low-stock',
  'over-budget',
  'attendance-summary',
  'top-receivables-payables',
];

describe('TileCatalog integrity', () => {
  it('registers exactly the seven Phase-1 tiles (FR-DSH-001)', () => {
    expect(TILE_CATALOG).toHaveLength(7);
    expect(TILE_CATALOG.map((t) => t.key).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('tile keys are unique', () => {
    const keys = TILE_CATALOG.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every tile drills into a registered RPT report (FR-DSH-002)', () => {
    const reportNames = new Set(REPORT_CATALOG.map((r) => r.name));
    for (const tile of TILE_CATALOG) {
      expect(reportNames.has(tile.drillToReport)).toBe(true);
    }
  });

  it('every tile carries a source, requiredPermission, projectScoped flag and non-empty roles', () => {
    const sources = new Set(['LEDGER', 'COST_CONTROL', 'SALES_IPC', 'INVENTORY', 'HR']);
    for (const tile of TILE_CATALOG) {
      expect(tile.key).toBeTruthy();
      expect(tile.title).toBeTruthy();
      expect(sources.has(tile.source)).toBe(true);
      expect(tile.requiredPermission).toBeTruthy();
      expect(tile.projectScoped).toBe(true);
      expect(tile.roles.length).toBeGreaterThan(0);
    }
  });

  it('the KPI→drill map matches the brief (FR-DSH-011…017)', () => {
    const drill = Object.fromEntries(TILE_CATALOG.map((t) => [t.key, t.drillToReport]));
    expect(drill['project-cash-flow']).toBe('cash-bank-book');
    expect(drill['pending-ipcs']).toBe('ipc-billing');
    expect(drill['retention-held']).toBe('ipc-billing');
    expect(drill['low-stock']).toBe('low-stock');
    expect(drill['over-budget']).toBe('cost-centre-variance');
    expect(drill['attendance-summary']).toBe('attendance-summary');
    expect(drill['top-receivables-payables']).toBe('account-ledger');
  });

  it('role→tile visibility matches overview §2', () => {
    const rolesOf = (key: string) => findTile(key)!.roles;
    // Store Keeper → low-stock only; HR Manager → attendance only.
    expect(rolesOf('low-stock')).toContain('STORE_KEEPER');
    expect(rolesOf('attendance-summary')).toEqual(expect.arrayContaining(['HR_MANAGER', 'ADMIN']));
    expect(rolesOf('attendance-summary')).not.toContain('STORE_KEEPER');
    // Financial tiles → Accounts + Admin.
    for (const key of ['project-cash-flow', 'top-receivables-payables', 'over-budget', 'pending-ipcs']) {
      expect(rolesOf(key)).toEqual(expect.arrayContaining(['ACCOUNTS_MANAGER', 'ADMIN']));
    }
    // Admin sees every tile.
    for (const tile of TILE_CATALOG) expect(tile.roles).toContain('ADMIN');
  });

  it('findTile returns undefined for an unknown key', () => {
    expect(findTile('nope')).toBeUndefined();
    expect(findTile('over-budget')?.source).toBe('COST_CONTROL');
  });
});
