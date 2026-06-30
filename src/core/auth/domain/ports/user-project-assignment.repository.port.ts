import { UserProjectAssignment } from '../user-project-assignment.entity';

export interface UserProjectAssignmentRepository {
  findByUserId(userId: string): Promise<UserProjectAssignment[]>;
  findByUserAndProject(userId: string, projectId: string): Promise<UserProjectAssignment | null>;
  replaceSet(userId: string, companyId: string, newProjectIds: string[]): Promise<{ added: string[]; removed: string[] }>;
  unassign(userId: string, projectId: string): Promise<void>;
  save(assignment: UserProjectAssignment): Promise<void>;
}

export const USER_PROJECT_ASSIGNMENT_REPOSITORY = Symbol('UserProjectAssignmentRepository');
