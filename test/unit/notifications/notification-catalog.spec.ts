/**
 * Notification Type Catalogue unit tests (NTF, FR-NTF-021). Validation + shape of the static catalogue.
 */
import {
  NOTIFICATION_TYPES,
  isValidNotificationType,
  getNotificationType,
} from '../../../src/core/notifications/domain/notification-catalog';

describe('NotificationCatalog', () => {
  it('recognises catalogue codes and rejects unknown ones', () => {
    expect(isValidNotificationType('REQ_SUBMITTED')).toBe(true);
    expect(isValidNotificationType('PERIOD_CLOSED')).toBe(true);
    expect(isValidNotificationType('NOPE_NOT_A_TYPE')).toBe(false);
  });

  it('every entry has a code, source module, severity and at least one recipient rule', () => {
    for (const t of NOTIFICATION_TYPES) {
      expect(t.code).toBeTruthy();
      expect(t.sourceModule).toBeTruthy();
      expect(['HIGH', 'NORMAL', 'LOW']).toContain(t.severity);
      expect(t.recipients.length).toBeGreaterThan(0);
    }
  });

  it('codes are unique', () => {
    const codes = NOTIFICATION_TYPES.map(t => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('getNotificationType returns the definition (severity + rules)', () => {
    const def = getNotificationType('USER_DEACTIVATED');
    expect(def?.severity).toBe('HIGH');
    expect(def?.sourceModule).toBe('AUD');
    expect(def?.recipients.map(r => r.kind)).toEqual(expect.arrayContaining(['USER', 'ROLE']));
  });

  it('PROJECT_ROLE and ROLE rules carry role names', () => {
    const def = getNotificationType('REQ_SUBMITTED')!;
    const projectRule = def.recipients.find(r => r.kind === 'PROJECT_ROLE');
    expect(projectRule && 'roles' in projectRule && projectRule.roles).toContain('PROJECT_MANAGER');
  });
});
