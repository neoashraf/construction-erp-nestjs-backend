/**
 * Bootstrap (ADR-0002 §2.3). Brings up the HTTP app with the platform cross-cutting concerns:
 *   - global `/api` prefix (overview §6),
 *   - nestjs-pino as the app logger (structured + correlation id),
 *   - global ValidationPipe (whitelist + forbidNonWhitelisted + transform),
 *   - OpenAPI/Swagger at `/api/v1/docs`,
 *   - graceful shutdown hooks (closes the DataSource).
 * The global error-envelope filter is bound in AppModule via APP_FILTER.
 */
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { getAppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // nestjs-pino is the app logger (NFR-010).
  app.useLogger(app.get(Logger));

  // NOTE: routes are already namespaced under /api by each @Controller('api/...')
  // (business controllers) — do NOT also call app.setGlobalPrefix('api') here or
  // every business route doubles to /api/api/... . Health/_diag live at /health, /_diag.

  // Fingerprint-device ingestion (`/iclock/cdata`) needs the body as RAW TEXT: ZKTeco firmware POSTs a
  // tab/comma-delimited payload with `text/plain` or no Content-Type at all, which the default JSON
  // parser would reject or mangle. Scoped to the `/iclock` prefix ON PURPOSE — the source project applied
  // `express.text({ type: () => true })` globally, which here would turn every JSON request body in the
  // ERP into a string. Registered before the ValidationPipe so device payloads never reach it.
  app.use('/iclock', express.text({ type: () => true, limit: '1mb' }));

  // Global validation (ADR-0002 §2.3): strip unknown fields, reject extras, coerce types.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableShutdownHooks();

  // OpenAPI — kept in sync with docs/api-contracts/ as modules land.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Zakir Enterprise — Construction ERP API')
    .setDescription('Project-centric construction ERP — accounting, projects, HR on one ledger.')
    .setVersion('0.1.0')
    // JWT bearer — the Authorize dialog takes the raw access token from POST /api/auth/login.
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Paste the accessToken from POST /api/auth/login' },
      'access-token',
    )
    .addTag('Health', 'Liveness / readiness probes')
    .addTag('Org', 'Companies and financial years')
    .addTag('Numbering', 'Voucher numbering series configuration')
    .addTag('Periods', 'Accounting period generation and lifecycle')
    .addTag('Ledger', 'General ledger read — entries, lines, trial balance')
    .addTag('Chart of Accounts', 'Account groups and accounts (CoA)')
    .addTag('Projects', 'Projects, budgets, and purposes')
    .addTag('Dimensions', 'Cost centres and godowns')
    .addTag('Parties', 'Customers, suppliers, and sub-contractors')
    .addTag('Items', 'Material / service items and UoM conversions')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  // Apply the JWT scheme as a GLOBAL security requirement so every operation shows the lock icon
  // and sends the token (public routes like /api/auth/login simply ignore it). One line here avoids
  // decorating every controller with @ApiBearerAuth().
  document.security = [{ 'access-token': [] }];
  SwaggerModule.setup('api/v1/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const { port } = getAppConfig(app.get(ConfigService));
  await app.listen(port);
  app.get(Logger).log(`ze-erp-nestjs-backend listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
