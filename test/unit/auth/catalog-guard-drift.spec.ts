/**
 * Catalogue ↔ guard drift test (aud-catalog-lifecycle #44 — FR-AUD-012/035).
 *
 * The Resource Catalogue (resource-catalog.ts) is the single source of truth for what can be
 * granted; @RequirePermission annotations are what the RolesGuard actually enforces. Nothing else
 * ties the two together — this spec does, in both directions:
 *
 *   (a) every @RequirePermission(resource, action) in src/ names a catalogue-declared pair —
 *       an out-of-catalogue annotation would be a grant key no role can ever hold (dead route);
 *   (b) every catalogue resource is enforced by at least one route annotation — an unenforced
 *       resource is a grant the editor can hand out that gates nothing (silent drift; this is
 *       exactly how `ledger.account_ledger` went dead until #44 re-annotated GET /api/ledger/lines).
 *
 * If (b) fails for a resource you just added: annotate its routes. If it fails for a resource you
 * are removing: remove the catalogue entry AND let the seed-time sweep clear the orphan grants —
 * and remember resource codes are stable identifiers (a rename ships as a data migration).
 */
import * as fs from 'fs';
import * as path from 'path';
import { RESOURCE_CODES, resourceAllowsAction } from '../../../src/core/auth/domain/resource-catalog';
import { ActionCode, ACTION_CODES } from '../../../src/core/auth/domain/permission.entity';

const SRC_DIR = path.resolve(__dirname, '../../../src');
const ANNOTATION = /@RequirePermission\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function collectAnnotatedPairs(): Array<{ file: string; resource: string; action: string }> {
  const pairs: Array<{ file: string; resource: string; action: string }> = [];
  for (const file of walk(SRC_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(ANNOTATION)) {
      pairs.push({ file: path.relative(SRC_DIR, file), resource: m[1], action: m[2] });
    }
  }
  return pairs;
}

describe('catalog-guard-drift (#44) — the catalogue and @RequirePermission cannot diverge', () => {
  const pairs = collectAnnotatedPairs();

  it('sanity: the scan finds the annotations (regex not silently broken)', () => {
    expect(pairs.length).toBeGreaterThan(50);
  });

  it('(a) every @RequirePermission(resource, action) is declared by the Resource Catalogue', () => {
    const invalid = pairs.filter(
      p => !ACTION_CODES.includes(p.action as ActionCode) || !resourceAllowsAction(p.resource, p.action as ActionCode),
    );
    expect(invalid).toEqual([]);
  });

  it('(b) every catalogue resource is enforced by at least one @RequirePermission route', () => {
    const annotatedResources = new Set(pairs.map(p => p.resource));
    const unenforced = RESOURCE_CODES.filter(code => !annotatedResources.has(code));
    expect(unenforced).toEqual([]);
  });
});
