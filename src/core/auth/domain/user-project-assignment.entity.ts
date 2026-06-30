/**
 * UserProjectAssignment domain entity (AUD RBAC — FR-AUD-014/015/020). PURE TypeScript.
 * Represents the user_project join: a scoped user may only see/write their assigned projects.
 * History is implicit in the audit log (CREATE on assign, DELETE on unassign — design §3.3).
 * No per-row version: replace-set semantics are last-writer-wins on the whole set (SRS §16).
 */
export interface UserProjectAssignmentProps {
  userId: string;
  projectId: string;
  companyId: string;
  assignedAt: Date;
}

export class UserProjectAssignment {
  private constructor(
    readonly id: string,
    private readonly _props: UserProjectAssignmentProps,
  ) {}

  get props(): Readonly<UserProjectAssignmentProps> {
    return this._props;
  }

  static create(id: string, props: UserProjectAssignmentProps): UserProjectAssignment {
    return new UserProjectAssignment(id, { ...props });
  }

  static rehydrate(id: string, props: UserProjectAssignmentProps): UserProjectAssignment {
    return new UserProjectAssignment(id, { ...props });
  }
}
