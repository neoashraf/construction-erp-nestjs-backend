/**
 * PurchaseProjectStatusPort (MAS, driven). Closed-project guard consulted by PUR before posting a bill;
 * LED ALSO re-checks inside `PostingService.post()` (belt-and-braces — FR-PUR-014; FR-LED-019), so a
 * project closing mid-post is caught at commit either way. This is a friendly early guard, not the only
 * one — mirrors HR's `HrProjectStatusPort` exactly (same rationale: the current `core/posting` MAS seam
 * bound in composition roots is `AllowAllProjectStatusService` until a real MAS-backed one lands there,
 * so callers add their own operative guard in the meantime).
 */
export interface PurchaseProjectStatusPort {
  assertNotClosed(companyId: string, projectId: string): Promise<void>;
}

export const PURCHASE_PROJECT_STATUS_PORT = Symbol('PurchaseProjectStatusPort');
