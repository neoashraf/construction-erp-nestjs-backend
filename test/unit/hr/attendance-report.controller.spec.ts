/**
 * AttendanceReportController HTTP tests — boots a Nest app with ONLY this controller (guards stubbed,
 * service faked, NO database) to prove the transport contract of REPORTS_MODULE_GUIDE §4/§5:
 *   - all six routes resolve at the documented paths;
 *   - JSON bodies are RAW — the platform `{ data, meta }` envelope is off (`@NoEnvelope`);
 *   - errors render flat as `{ "error": "…" }` (`AttendanceReportExceptionFilter`), not the platform
 *     `{ error: { code, message, details } }` envelope;
 *   - exports send `text/csv; charset=utf-8`, the documented filename, and a UTF-8 BOM first byte.
 */
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { ResponseEnvelopeInterceptor } from '../../../src/infrastructure/http/response-envelope.interceptor';
import { JwtAuthGuard } from '../../../src/core/auth/presentation/jwt-auth.guard';
import { RolesGuard } from '../../../src/core/auth/presentation/roles.guard';
import { Actor } from '../../../src/core/tenancy/tenant-context';
import { AttendanceReportService } from '../../../src/modules/hr/attendance-reports/application/attendance-report.service';
import { AttendanceReportController } from '../../../src/modules/hr/attendance-reports/presentation/attendance-report.controller';
import { badRequest } from '../../../src/modules/hr/attendance-reports/domain/attendance-rules';

/** What JwtStrategy puts on the request in production; `@CurrentActor()` reads it back. */
const ACTOR: Actor = {
  userId: 'u1',
  companyId: 'co1',
  financialYearId: 'fy1',
  role: 'Admin',
  isUnscoped: true,
  assignedProjectIds: [],
  approvalLimit: null,
};

/**
 * Stands in for the real JWT guard. It must SET `request.user` — not just return true — because
 * `@CurrentActor()` resolves the actor from there and 401s when it is missing.
 */
const stubJwtGuard = {
  canActivate: (context: ExecutionContext): boolean => {
    context.switchToHttp().getRequest<Request & { user?: Actor }>().user = ACTOR;
    return true;
  },
};

const DAILY_BODY = {
  date: '2026-07-26',
  isHoliday: false,
  holiday: null,
  lateAfter: '09:30',
  totals: {
    totalEmployees: 1,
    workingDays: 1,
    onTimeCount: 1,
    lateCount: 0,
    presentCount: 1,
    absentCount: 0,
    holidayCount: 0,
    attendancePercentage: 100,
  },
  data: [],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

class FakeService {
  getDailyReport = jest.fn().mockResolvedValue(DAILY_BODY);
  getRangeReport = jest.fn().mockResolvedValue({ label: 'July 2026' });
  getSummaryReport = jest.fn().mockResolvedValue({ label: 'July 2026' });
  exportDailyReportCsv = jest.fn().mockResolvedValue('a,b\r\nc,d');
  exportRangeReportCsv = jest.fn().mockResolvedValue('range,csv');
  exportSummaryReportCsv = jest.fn().mockResolvedValue('summary,csv');
}

describe('AttendanceReportController', () => {
  let app: INestApplication;
  let service: FakeService;

  beforeEach(async () => {
    service = new FakeService();

    const moduleRef = await Test.createTestingModule({
      controllers: [AttendanceReportController],
      providers: [
        { provide: AttendanceReportService, useValue: service },
        // The envelope interceptor is registered so the test proves @NoEnvelope actually suppresses it,
        // rather than proving the interceptor merely wasn't wired.
        { provide: APP_INTERCEPTOR, useFactory: (r: Reflector) => new ResponseEnvelopeInterceptor(r), inject: [Reflector] },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(stubJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('JSON routes', () => {
    it('serves GET /api/reports/daily unwrapped by the platform envelope', async () => {
      const res = await request(app.getHttpServer()).get('/api/reports/daily?date=2026-07-26');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(DAILY_BODY);
      expect(res.body).not.toHaveProperty('data.data'); // no { data, meta } wrapper
      expect(res.body).not.toHaveProperty('meta');
    });

    it('passes the query through to the service verbatim', async () => {
      await request(app.getHttpServer()).get(
        '/api/reports/range?dateFrom=2026-07-01&dateTo=2026-07-26&page=2&limit=50&userId=1042&name=Karim',
      );

      expect(service.getRangeReport).toHaveBeenCalledWith(
        {
          dateFrom: '2026-07-01',
          dateTo: '2026-07-26',
          page: '2',
          limit: '50',
          userId: '1042',
          name: 'Karim',
        },
        ACTOR,
      );
    });

    it('serves GET /api/reports/summary', async () => {
      const res = await request(app.getHttpServer()).get('/api/reports/summary');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ label: 'July 2026' });
    });
  });

  describe('error shape (§4.5)', () => {
    it('renders a validation failure as a flat { error: "…" } body', async () => {
      service.getRangeReport.mockRejectedValueOnce(
        badRequest('dateFrom and dateTo must be supplied together'),
      );

      const res = await request(app.getHttpServer()).get('/api/reports/range?dateFrom=2026-07-01');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'dateFrom and dateTo must be supplied together' });
    });

    it('redacts an unexpected failure as 500 Internal server error', async () => {
      service.getDailyReport.mockRejectedValueOnce(new Error('connection terminated'));

      const res = await request(app.getHttpServer()).get('/api/reports/daily');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('CSV exports (§5.1)', () => {
    it('sends the daily export with a BOM, csv content type and the documented filename', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/reports/daily/export?date=2026-07-26',
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="attendance-daily-2026-07-26.csv"',
      );
      expect(res.text.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM so Excel decodes Bangla names
      expect(res.text.slice(1)).toBe('a,b\r\nc,d');
    });

    it('names the range export <from>_to_<to>', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/reports/range/export?dateFrom=2026-07-01&dateTo=2026-07-26',
      );

      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="attendance-range-2026-07-01_to_2026-07-26.csv"',
      );
    });

    it('falls back to today in the filename when the range is not given', async () => {
      const res = await request(app.getHttpServer()).get('/api/reports/summary/export');

      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="attendance-summary-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
    });

    it('accepts page/limit on an export and still exports everything', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/reports/daily/export?date=2026-07-26&page=2&limit=5',
      );

      expect(res.status).toBe(200);
      expect(service.exportDailyReportCsv).toHaveBeenCalled();
    });
  });
});
