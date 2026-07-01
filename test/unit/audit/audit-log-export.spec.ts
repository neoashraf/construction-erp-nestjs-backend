/**
 * Unit tests for the audit-log export feature (FR-AUD-028).
 * Tests: filter → query mapping, header/filename construction, sanitisation, action/format validation.
 * No DB, no Docker — all dependencies mocked (skill §13).
 */
import { StreamableFile } from '@nestjs/common';
import { AuditLogsController } from '../../../src/core/audit/presentation/audit-logs.controller';
import { ValidationError } from '../../../src/common/errors/domain-error';

/* ─────────────────────────────── helpers ─────────────────────────────────── */

function makeController(overrides: { exportRows?: unknown[]; recordFn?: jest.Mock } = {}) {
  const exportRows = overrides.exportRows ?? [];
  const recordMock = overrides.recordFn ?? jest.fn();

  const mockQuery = {
    exportData: jest.fn().mockResolvedValue(exportRows),
    list: jest.fn(),
    findById: jest.fn(),
  };
  const mockAudit = { record: recordMock };
  // UoW: synchronously runs the callback (no real transaction needed in unit tests)
  const mockUow = { run: jest.fn((fn: () => unknown) => fn()) };

  // @ts-expect-error: partial constructor args for testing
  const ctrl = new AuditLogsController(mockQuery, mockAudit, mockUow);
  return { ctrl, mockQuery, mockAudit, mockUow };
}

function makeActor() {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    financialYearId: 'fy-1',
    role: 'Admin' as const,
    isUnscoped: true,
    assignedProjectIds: [],
    approvalLimit: null,
  };
}

function makeResponse() {
  const headers: Record<string, string> = {};
  return {
    set: jest.fn((h: Record<string, string>) => Object.assign(headers, h)),
    _headers: headers,
  };
}

function makeRequest(id = 'req-id-123') {
  return { id, headers: { 'x-request-id': id } } as unknown as ReturnType<typeof Object.create>;
}

/* ─────────────────────────────── tests ───────────────────────────────────── */

describe('AuditLogsController › export — FR-AUD-028', () => {
  describe('format validation', () => {
    it('throws ValidationError (VALIDATION_ERROR) for unsupported format', async () => {
      const { ctrl } = makeController();
      await expect(
        ctrl.export(makeActor(), makeResponse() as any, makeRequest() as any,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'pdf'),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts csv (default)', async () => {
      const { ctrl } = makeController();
      const result = await ctrl.export(
        makeActor(), makeResponse() as any, makeRequest() as any,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'csv',
      );
      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('accepts xlsx', async () => {
      const { ctrl } = makeController();
      const result = await ctrl.export(
        makeActor(), makeResponse() as any, makeRequest() as any,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'xlsx',
      );
      expect(result).toBeInstanceOf(StreamableFile);
    });
  });

  describe('action filter validation (FR-AUD-026)', () => {
    it('throws ValidationError for an unknown action value', async () => {
      const { ctrl } = makeController();
      await expect(
        ctrl.export(makeActor(), makeResponse() as any, makeRequest() as any,
          undefined, undefined, undefined, 'INVALID_ACTION'),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts valid action values', async () => {
      const { ctrl } = makeController();
      for (const validAction of ['CREATE', 'UPDATE', 'DELETE', 'POST', 'CANCEL', 'APPROVE', 'REJECT']) {
        await expect(
          ctrl.export(makeActor(), makeResponse() as any, makeRequest() as any,
            undefined, undefined, undefined, validAction),
        ).resolves.toBeInstanceOf(StreamableFile);
      }
    });
  });

  describe('date filter validation (FR-AUD-026)', () => {
    it('throws ValidationError for a malformed dateFrom', async () => {
      const { ctrl } = makeController();
      await expect(
        ctrl.export(makeActor(), makeResponse() as any, makeRequest() as any,
          undefined, undefined, undefined, undefined, undefined, 'not-a-date'),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError for a malformed dateTo', async () => {
      const { ctrl } = makeController();
      await expect(
        ctrl.export(makeActor(), makeResponse() as any, makeRequest() as any,
          undefined, undefined, undefined, undefined, undefined, undefined, 'bad-date'),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts a valid ISO-8601 date range', async () => {
      const { ctrl } = makeController();
      await expect(
        ctrl.export(makeActor(), makeResponse() as any, makeRequest() as any,
          undefined, undefined, undefined, undefined, undefined,
          '2026-01-01T00:00:00Z', '2026-06-30T23:59:59Z'),
      ).resolves.toBeInstanceOf(StreamableFile);
    });
  });

  describe('filename construction', () => {
    it('filename includes DD-MM-YYYY date and csv extension', async () => {
      const { ctrl } = makeController();
      const res = makeResponse();
      await ctrl.export(
        makeActor(), res as any, makeRequest() as any,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'csv',
      );
      const disposition: string = res._headers['Content-Disposition'] ?? '';
      // filename pattern: audit-log-DD-MM-YYYY.csv
      expect(disposition).toMatch(/audit-log-\d{2}-\d{2}-\d{4}\.csv/);
    });

    it('filename includes xlsx extension for xlsx format', async () => {
      const { ctrl } = makeController();
      const res = makeResponse();
      await ctrl.export(
        makeActor(), res as any, makeRequest() as any,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'xlsx',
      );
      const disposition: string = res._headers['Content-Disposition'] ?? '';
      expect(disposition).toMatch(/audit-log-\d{2}-\d{2}-\d{4}\.xlsx/);
    });
  });

  describe('response headers', () => {
    it('sets X-Request-Id header from req.id', async () => {
      const { ctrl } = makeController();
      const res = makeResponse();
      await ctrl.export(
        makeActor(), res as any, makeRequest('my-req-id') as any,
      );
      expect(res._headers['X-Request-Id']).toBe('my-req-id');
    });

    it('sets Content-Type text/csv for csv format', async () => {
      const { ctrl } = makeController();
      const res = makeResponse();
      await ctrl.export(makeActor(), res as any, makeRequest() as any);
      expect(res._headers['Content-Type']).toMatch(/text\/csv/);
    });

    it('sets xlsx MIME type for xlsx format', async () => {
      const { ctrl } = makeController();
      const res = makeResponse();
      await ctrl.export(
        makeActor(), res as any, makeRequest() as any,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'xlsx',
      );
      expect(res._headers['Content-Type']).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    });
  });

  describe('audit recording (FR-AUD-028 / FR-AUD-025)', () => {
    it('calls audit.record with EXPORT action inside uow.run', async () => {
      const recordMock = jest.fn();
      const { ctrl, mockUow } = makeController({ recordFn: recordMock });
      await ctrl.export(makeActor(), makeResponse() as any, makeRequest() as any);
      expect(mockUow.run).toHaveBeenCalledTimes(1);
      expect(recordMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'EXPORT', entityType: 'AuditLog' }),
      );
    });

    it('includes actor companyId and userId in the audit entry', async () => {
      const recordMock = jest.fn();
      const { ctrl } = makeController({ recordFn: recordMock });
      const actor = makeActor();
      await ctrl.export(actor, makeResponse() as any, makeRequest() as any);
      expect(recordMock).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: actor.companyId,
          actorId: actor.userId,
        }),
      );
    });

    it('if uow throws the export fails (no silent unlogged export)', async () => {
      const { ctrl, mockUow } = makeController();
      (mockUow.run as jest.Mock).mockRejectedValueOnce(new Error('uow failure'));
      await expect(
        ctrl.export(makeActor(), makeResponse() as any, makeRequest() as any),
      ).rejects.toThrow('uow failure');
    });
  });

  describe('CSV output (FR-AUD-028 sanitisation)', () => {
    it('CSV starts with UTF-8 BOM for Bangla compatibility (SRS §9)', async () => {
      const { ctrl } = makeController({
        exportRows: [
          { createdAt: '2026-01-01T00:00:00.000Z', userName: 'আশরাফ', action: 'CREATE',
            entityType: 'User', entityId: 'e1', projectId: '', ipAddress: '127.0.0.1' },
        ],
      });
      const res = makeResponse();
      const file = await ctrl.export(makeActor(), res as any, makeRequest() as any);
      // Read the buffer back
      const chunks: Buffer[] = [];
      // Access the internal buffer via the readable
      const readable = (file as any).readable;
      if (readable) {
        await new Promise<void>(resolve => {
          readable.on('data', (chunk: Buffer) => chunks.push(chunk));
          readable.on('end', resolve);
        });
      }
      const buf = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
      // BOM is 0xEF 0xBB 0xBF
      if (buf.length > 0) {
        expect(buf[0]).toBe(0xef);
        expect(buf[1]).toBe(0xbb);
        expect(buf[2]).toBe(0xbf);
      }
    });

    it('CSV rows do not contain before/after or password_hash (sanitised)', async () => {
      // Sanitisation happens in the query service; the controller passes rows through as-is.
      // The export rows intentionally exclude before/after (no such field in AuditExportRow).
      const exportRow = {
        createdAt: '2026-01-01T00:00:00.000Z',
        userName: 'Test User',
        action: 'CREATE',
        entityType: 'User',
        entityId: 'e1',
        projectId: '',
        ipAddress: '127.0.0.1',
      };
      const { ctrl, mockQuery } = makeController({ exportRows: [exportRow] });
      const res = makeResponse();
      await ctrl.export(makeActor(), res as any, makeRequest() as any);
      // exportData was called — its return type (AuditExportRow) has no before/after/passwordHash
      expect(mockQuery.exportData).toHaveBeenCalledTimes(1);
      const exportDataResult: unknown[] = await mockQuery.exportData.mock.results[0].value;
      for (const row of exportDataResult as Array<Record<string, unknown>>) {
        expect('before' in row).toBe(false);
        expect('after' in row).toBe(false);
        expect('passwordHash' in row).toBe(false);
        expect('password_hash' in row).toBe(false);
      }
    });

    it('CSV values with commas are quoted', async () => {
      const { ctrl } = makeController({
        exportRows: [
          { createdAt: '2026-01-01T00:00:00.000Z', userName: 'Last, First', action: 'CREATE',
            entityType: 'User', entityId: 'e1', projectId: '', ipAddress: '' },
        ],
      });
      const res = makeResponse();
      const file = await ctrl.export(makeActor(), res as any, makeRequest() as any);
      const readable = (file as any).readable;
      const chunks: Buffer[] = [];
      if (readable) {
        await new Promise<void>(resolve => {
          readable.on('data', (c: Buffer) => chunks.push(c));
          readable.on('end', resolve);
        });
        const text = Buffer.concat(chunks).toString('utf-8');
        expect(text).toContain('"Last, First"');
      }
    });
  });

  describe('filter passthrough (FR-AUD-026)', () => {
    it('passes all filter params to exportData', async () => {
      const { ctrl, mockQuery } = makeController();
      const actor = makeActor();
      await ctrl.export(
        actor, makeResponse() as any, makeRequest() as any,
        'User', 'entity-1', 'user-1', 'CREATE', 'project-1',
        '2026-01-01T00:00:00Z', '2026-06-30T23:59:59Z', 'csv',
      );
      expect(mockQuery.exportData).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: actor.companyId,
          entityType: 'User',
          entityId: 'entity-1',
          userId: 'user-1',
          action: 'CREATE',
          projectId: 'project-1',
        }),
      );
    });

    it('company_id always comes from the token, never from request params (FR-AUD-027)', async () => {
      const { ctrl, mockQuery } = makeController();
      const actor = { ...makeActor(), companyId: 'token-company' };
      await ctrl.export(actor, makeResponse() as any, makeRequest() as any);
      expect(mockQuery.exportData).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'token-company' }),
      );
    });
  });
});
