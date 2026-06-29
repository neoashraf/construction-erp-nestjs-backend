/**
 * Tenancy module (core kernel). Houses the `Actor`/`TenantContext` shapes and the scoped-repository
 * base. No providers yet — the base is a class feature modules extend, and the request-scoped
 * `Actor` is supplied by the auth layer (AUD brief). Kept as a registered module so later briefs add
 * a current-user provider / interceptor here without restructuring.
 */
import { Module } from '@nestjs/common';

@Module({})
export class TenancyModule {}
