/**
 * Typed config module (ADR-0002 §2.3 Config). Loads env, validates it with Joi (fail-fast),
 * and exposes the typed `registerAs` namespaces. Global so any module can inject ConfigService.
 */
import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { envValidationSchema } from './env.schema';
import { appConfig, databaseConfig, jwtConfig, cloudinaryConfig, deviceConfig } from './app-config';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // `.env` for local dev; in real environments the process env is authoritative.
      envFilePath: ['.env'],
      load: [appConfig, databaseConfig, jwtConfig, cloudinaryConfig, deviceConfig],
      validationSchema: envValidationSchema,
      validationOptions: {
        // fail-fast: surface ALL invalid vars at once, never boot partially.
        abortEarly: false,
      },
    }),
  ],
})
export class AppConfigModule {}
