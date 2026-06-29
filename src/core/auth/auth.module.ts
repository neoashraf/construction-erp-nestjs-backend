/**
 * Auth kernel module (AUD) — EMPTY-BUT-WIRED.
 *
 * JWT authn (access+refresh), the `@CurrentUser()`→`Actor` decorator, and the RBAC `@Roles()` guard
 * land here in the `auth-jwt` brief. NO JWT strategy, guards, or auth entities ship in the scaffold
 * (explicitly out of scope per the brief). Single role per user; approval limits escalate-by-default.
 */
import { Module } from '@nestjs/common';

@Module({})
export class AuthModule {}
