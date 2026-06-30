/**
 * @CurrentUser() — alias for @CurrentActor(). Resolves the JWT-validated Actor from request.user.
 * The JwtStrategy sets request.user; this decorator extracts it (FR-AUD-003, design §2.2).
 */
export { CurrentActor as CurrentUser } from './current-actor.decorator';
