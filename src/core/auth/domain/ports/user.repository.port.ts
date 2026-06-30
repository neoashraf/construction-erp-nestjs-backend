/** UserRepository port — company-scoped user reads + writes (AUD domain). */
import { User } from '../user';

export interface UserRepository {
  findByEmail(companyId: string, email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  save(user: User): Promise<void>;
}
export const USER_REPOSITORY = Symbol('UserRepository');
