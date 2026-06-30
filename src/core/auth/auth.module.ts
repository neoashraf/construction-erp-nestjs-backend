/**
 * AuthModule — JWT authentication + RBAC kernel (AUD · auth-jwt + rbac-and-audit briefs).
 * Wires: User/Role/Permission/UserProject repos, BcryptPasswordHasher, JwtTokenSigner,
 * DbRefreshTokenStore, AuthService, RoleUseCases, PermissionUseCases, UserProjectUseCases,
 * UserAdminUseCases, JwtStrategy, JwtAuthGuard, RolesGuard, AccessPolicy, all controllers.
 * Exports AuthService + JwtAuthGuard + RolesGuard + AccessPolicy + JwtModule for other modules.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './application/auth.service';
import { RoleUseCases, PermissionUseCases, UserProjectUseCases, UserAdminUseCases } from './application/rbac.use-cases';
import { BcryptPasswordHasher } from './infrastructure/bcrypt-password-hasher';
import { JwtTokenSigner } from './infrastructure/jwt-token-signer';
import { DbRefreshTokenStore } from './infrastructure/db-refresh-token-store';
import { TypeOrmUserRepository } from './infrastructure/typeorm-user.repository';
import { TypeOrmRoleRepository } from './infrastructure/typeorm-role.repository';
import { TypeOrmPermissionRepository } from './infrastructure/typeorm-permission.repository';
import { TypeOrmUserProjectRepository } from './infrastructure/typeorm-user-project.repository';
import { JwtStrategy } from './presentation/jwt.strategy';
import { JwtAuthGuard } from './presentation/jwt-auth.guard';
import { RolesGuard } from './presentation/roles.guard';
import { AuthController } from './presentation/auth.controller';
import { RolesController } from './presentation/roles.controller';
import { PermissionsController } from './presentation/permissions.controller';
import { UsersController } from './presentation/users.controller';
import { UserProjectsController } from './presentation/user-projects.controller';
import { AccessPolicy } from './domain/access-policy';
import { RolesQueryService } from './read/roles.query-service';
import { PermissionsQueryService } from './read/permissions.query-service';
import { UsersQueryService } from './read/users.query-service';
import { PASSWORD_HASHER } from './domain/ports/password-hasher.port';
import { TOKEN_SIGNER } from './domain/ports/token-signer.port';
import { REFRESH_TOKEN_STORE } from './domain/ports/refresh-token-store.port';
import { USER_REPOSITORY } from './domain/ports/user.repository.port';
import { ROLE_REPOSITORY } from './domain/ports/role.repository.port';
import { PERMISSION_REPOSITORY } from './domain/ports/permission.repository.port';
import { USER_PROJECT_ASSIGNMENT_REPOSITORY } from './domain/ports/user-project-assignment.repository.port';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_ACCESS_TTL', '900s') as any },
      }),
    }),
  ],
  controllers: [AuthController, RolesController, PermissionsController, UsersController, UserProjectsController],
  providers: [
    AuthService,
    RoleUseCases,
    PermissionUseCases,
    UserProjectUseCases,
    UserAdminUseCases,
    AccessPolicy,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    RolesQueryService,
    PermissionsQueryService,
    UsersQueryService,
    { provide: USER_REPOSITORY, useClass: TypeOrmUserRepository },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOKEN_SIGNER, useClass: JwtTokenSigner },
    { provide: REFRESH_TOKEN_STORE, useClass: DbRefreshTokenStore },
    { provide: ROLE_REPOSITORY, useClass: TypeOrmRoleRepository },
    { provide: PERMISSION_REPOSITORY, useClass: TypeOrmPermissionRepository },
    { provide: USER_PROJECT_ASSIGNMENT_REPOSITORY, useClass: TypeOrmUserProjectRepository },
  ],
  exports: [AuthService, JwtAuthGuard, RolesGuard, AccessPolicy, JwtModule, ROLE_REPOSITORY, PERMISSION_REPOSITORY, USER_PROJECT_ASSIGNMENT_REPOSITORY],
})
export class AuthModule {}
