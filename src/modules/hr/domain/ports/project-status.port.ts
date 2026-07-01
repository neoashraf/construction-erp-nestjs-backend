/**
 * HrProjectStatusPort (MAS, driven). Closed-project guard consulted by HR before confirming an accrual;
 * LED ALSO re-checks inside post() (belt-and-braces), so a project closing mid-confirm is caught at commit
 * (FR-HR-018; FR-LED-019). PURE interface; the MAS adapter reads project.status.
 */
export interface HrProjectStatusPort {
  assertNotClosed(companyId: string, projectId: string): Promise<void>;
}

export const HR_PROJECT_STATUS_PORT = Symbol('HrProjectStatusPort');
