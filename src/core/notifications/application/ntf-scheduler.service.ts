/**
 * NtfSchedulerService (NTF application — FR-NTF-022..025). Raises the time-driven reminders that have no
 * state-transition to listen for. The `@Cron` entry points read the reference date from the Clock and
 * delegate to pure, deterministic `scan*` methods (so they unit-test without cron timing). Each reminder
 * is idempotent via a due-window `eventKey` + the store's (recipient, event_key) unique — a re-run the
 * same day creates nothing. Read-only + emit only: no ledger write, no period/IPC state change (FR-NTF-025).
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Clock, CLOCK } from '../../../common/ports/clock.port';
import { NotificationService } from './notification.service';
import { NtfDueQueryService } from '../read/ntf-due.query-service';

const PERIOD_CLOSING_WINDOW_DAYS = 7;

@Injectable()
export class NtfSchedulerService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly due: NtfDueQueryService,
    private readonly notifications: NotificationService,
  ) {}

  /** Daily reminder sweep. Cron only reads the clock + delegates — all logic is in the scan methods. */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async runDailyReminders(): Promise<void> {
    const today = this.clock.now().toISOString().slice(0, 10);
    await this.scanPeriodClosingSoon(today);
    await this.scanOverdueIpcs(today);
  }

  /** PERIOD_CLOSING_SOON for OPEN periods ending within the warning window. `today` = YYYY-MM-DD. */
  async scanPeriodClosingSoon(today: string): Promise<number> {
    const rows = await this.due.periodsClosingSoon(today, PERIOD_CLOSING_WINDOW_DAYS);
    let raised = 0;
    for (const p of rows) {
      const { created } = await this.notifications.emit({
        type: 'PERIOD_CLOSING_SOON',
        companyId: p.companyId,
        title: `Accounting period "${p.name}" closes on ${p.endDate}`,
        body: 'Post or finalise entries for this period before it closes — posting into a closed period is rejected.',
        sourceEntityType: 'AccountingPeriod', sourceEntityId: p.id,
        eventKey: `period-closing:${p.id}:${p.endDate}`,
      });
      raised += created > 0 ? 1 : 0;
    }
    return raised;
  }

  /** IPC_OVERDUE for POSTED IPCs past their due date, scoped to the IPC's project. `today` = YYYY-MM-DD. */
  async scanOverdueIpcs(today: string): Promise<number> {
    const rows = await this.due.overdueIpcs(today);
    let raised = 0;
    for (const ipc of rows) {
      const label = ipc.ipcSeqNo != null ? `IPC #${ipc.ipcSeqNo}` : 'An IPC';
      const { created } = await this.notifications.emit({
        type: 'IPC_OVERDUE',
        companyId: ipc.companyId,
        projectId: ipc.projectId,
        title: `${label} is overdue (due ${ipc.dueDate})`,
        body: 'This interim payment certificate is past its due date — follow up on collection.',
        sourceEntityType: 'IPC', sourceEntityId: ipc.id,
        eventKey: `ipc-overdue:${ipc.id}:${ipc.dueDate}`,
      });
      raised += created > 0 ? 1 : 0;
    }
    return raised;
  }
}
