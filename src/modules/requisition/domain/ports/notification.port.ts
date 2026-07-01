/**
 * NotificationPort (driven; owner AUD/platform). REQ produces the notification TRIGGER + recipient at each
 * transition (submit → the tier approver; approve → Store Keeper + requester; reject/close → requester);
 * the delivery channel (SMS is a primary channel — overview §9 — or in-app) is AUD/platform. Dispatched
 * after commit on the domain events (design §6). PURE interface; this brief binds a logging/no-op adapter
 * (the seam is what matters — FR-REQ-007/-023).
 */

export type RequisitionEvent =
  | 'REQUISITION_SUBMITTED'
  | 'REQUISITION_APPROVED'
  | 'REQUISITION_REJECTED'
  | 'REQUISITION_CLOSED';

export interface RequisitionNotification {
  event: RequisitionEvent;
  requisitionId: string;
  companyId: string;
  projectId: string;
  /** The role(s) to notify for this transition, e.g. 'APPROVER', 'REQUESTER', 'STORE_KEEPER'. */
  recipients: string[];
}

export interface NotificationPort {
  notify(notification: RequisitionNotification): Promise<void>;
}

export const NOTIFICATION_PORT = Symbol('RequisitionNotificationPort');
