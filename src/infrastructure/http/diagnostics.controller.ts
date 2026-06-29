/**
 * DiagnosticsController — NON-PRODUCTION ONLY (mounted by DiagnosticsModule when NODE_ENV is not
 * 'production'). Deliberately throws / echoes so the global exception filter, the error envelope, and
 * the global ValidationPipe can be exercised by the e2e smoke test. Ships no business behaviour.
 */
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsInt, IsString } from 'class-validator';
import { ValidationError } from '../../common/errors/domain-error';

/** A whitelisted DTO so the global ValidationPipe rejects unknown fields and coerces types. */
class EchoDto {
  @IsString()
  name!: string;

  @IsInt()
  count!: number;
}

@ApiExcludeController()
@Controller('_diag')
export class DiagnosticsController {
  /** Throws a typed domain error → mapped to its code + HTTP 400 by the filter. */
  @Get('domain-error')
  domainError(): never {
    throw new ValidationError('deliberate domain error for smoke test', { field: 'demo' });
  }

  /** Throws an arbitrary, unhandled error → 500 INTERNAL_ERROR with internals redacted. */
  @Get('unhandled')
  unhandled(): never {
    throw new Error('deliberate unhandled error for smoke test');
  }

  /** Echoes a validated DTO — proves whitelist/forbidNonWhitelisted + transform are active. */
  @Post('echo')
  @HttpCode(200)
  echo(@Body() dto: EchoDto): { name: string; count: number; countType: string } {
    return { name: dto.name, count: dto.count, countType: typeof dto.count };
  }
}
