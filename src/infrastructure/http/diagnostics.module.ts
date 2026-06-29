/**
 * DiagnosticsModule — registers the throwing DiagnosticsController only when explicitly enabled
 * (non-production). Lets the e2e smoke assert the error envelope against the real app without
 * exposing diagnostic routes in production.
 */
import { DynamicModule, Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller';

@Module({})
export class DiagnosticsModule {
  static register(enabled: boolean): DynamicModule {
    return {
      module: DiagnosticsModule,
      controllers: enabled ? [DiagnosticsController] : [],
    };
  }
}
