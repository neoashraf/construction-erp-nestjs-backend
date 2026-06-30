/**
 * AuthModule — JWT authentication kernel (AUD · auth-jwt brief).
 * Wires: User + RefreshToken repos, BcryptPasswordHasher, JwtTokenSigner, DbRefreshTokenStore,
 * AuthService, JwtStrategy, JwtAuthGuard, AuthController.
 * Exports AuthService (for JwtStrategy + other modules) and JwtAuthGuard (used by all controllers).
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './application/auth.service';
import { BcryptPasswordHasher } from './infrastructure/bcrypt-password-hasher';
import { JwtTokenSigner } from './infrastructure/jwt-token-signer';
import { DbRefreshTokenStore } from './infrastructure/db-refresh-token-store';
import { TypeOrmUserRepository } from './infrastructure/typeorm-user.repository';
import { JwtStrategy } from './presentation/jwt.strategy';
import { JwtAuthGuard } from './presentation/jwt-auth.guard';
import { AuthController } from './presentation/auth.controller';
import { PASSWORD_HASHER } from './domain/ports/password-hasher.port';
import { TOKEN_SIGNER } from './domain/ports/token-signer.port';
import { REFRESH_TOKEN_STORE } from './domain/ports/refresh-token-store.port';
import { USER_REPOSITORY } from './domain/ports/user.repository.port';

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
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    { provide: USER_REPOSITORY, useClass: TypeOrmUserRepository },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOKEN_SIGNER, useClass: JwtTokenSigner },
    { provide: REFRESH_TOKEN_STORE, useClass: DbRefreshTokenStore },
  ],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
