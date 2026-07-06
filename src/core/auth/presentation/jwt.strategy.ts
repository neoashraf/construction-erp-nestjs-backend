/**
 * JwtStrategy (PRESENTATION) — passport-jwt, validates signature + expiry, re-loads user,
 * asserts is_active, and enriches Actor with RBAC data (isUnscoped, assignedProjectIds, approvalLimit).
 * FR-AUD-003/009/014/015/016.
 */
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from '../application/auth.service';
import { Actor } from '../../tenancy/tenant-context';
import { RoleRepository, ROLE_REPOSITORY } from '../domain/ports/role.repository.port';
import { UserProjectAssignmentRepository, USER_PROJECT_ASSIGNMENT_REPOSITORY } from '../domain/ports/user-project-assignment.repository.port';

interface JwtPayload {
  sub: string;
  companyId: string;
  financialYearId: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(USER_PROJECT_ASSIGNMENT_REPOSITORY) private readonly userProjects: UserProjectAssignmentRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /** Called after signature + expiry validation; re-checks is_active and enriches RBAC context (FR-AUD-009). */
  async validate(payload: JwtPayload): Promise<Actor> {
    const user = await this.auth.validateUserById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User is inactive or not found');
    }

    const companyId = user.props.companyId;
    const roleName = user.props.role;

    // Load RBAC context for Actor enrichment
    const [role, assignments] = await Promise.all([
      this.roles.findByName(companyId, roleName).catch(() => null),
      this.userProjects.findByUserId(user.id).catch(() => []),
    ]);

    return {
      userId: user.id,
      companyId,
      financialYearId: user.props.financialYearId,
      role: user.props.role,
      isUnscoped: role?.props.isUnscoped ?? false,
      assignedProjectIds: assignments.map(a => a.props.projectId),
      approvalLimit: role?.props.approvalLimit ?? null,
    };
  }
}
