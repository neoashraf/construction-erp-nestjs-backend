/**
 * Structured logging (NFR-010, ADR-0002 §2.3 Observability) — nestjs-pino.
 *
 * JSON logs with a per-request CORRELATION ID (`x-request-id` echoed, or a generated UUID), retained
 * ≥12 months downstream. Secrets/PII are redacted (Authorization header, passwords, tokens) and
 * never logged. Pretty-printing is enabled only in development.
 */
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { getAppConfig } from '../../config/app-config';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = getAppConfig(config);
        const isDev = app.nodeEnv === 'development';
        return {
          pinoHttp: {
            level: app.logLevel,
            // correlation id: reuse an inbound id or mint one; exposed back on the response.
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const existing = (req.headers['x-request-id'] as string) || randomUUID();
              res.setHeader('x-request-id', existing);
              return existing;
            },
            customProps: (req: IncomingMessage) => ({
              correlationId: (req as IncomingMessage & { id?: string }).id,
            }),
            // never log secrets / PII.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.passwordHash',
                'req.body.token',
                'res.headers["set-cookie"]',
              ],
              remove: true,
            },
            transport: isDev
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:standard' } }
              : undefined,
          },
        };
      },
    }),
  ],
})
export class AppLoggerModule {}
