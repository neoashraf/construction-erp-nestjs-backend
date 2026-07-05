/**
 * RecipientResolver port — turns a catalogue recipient RULE + event context into a set of active
 * recipient user ids (NTF domain, FR-NTF-017/018/020). Reads AUD's live user/role/user_project data;
 * excludes inactive users; company-scoped. NTF keeps no copy of roles or assignments.
 */
import { RecipientRule } from '../notification-catalog';

export interface RecipientContext {
  companyId: string;
  projectId?: string | null;
  affectedUserId?: string | null;
}

export interface RecipientResolver {
  /** Resolve one rule to active recipient user ids (empty if none / rule not applicable to the context). */
  resolve(rule: RecipientRule, ctx: RecipientContext): Promise<string[]>;
}
export const RECIPIENT_RESOLVER = Symbol('RecipientResolver');
