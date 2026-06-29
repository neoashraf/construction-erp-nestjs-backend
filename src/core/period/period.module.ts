/**
 * Period-control kernel module (PER) — EMPTY-BUT-WIRED.
 *
 * `PeriodService.assertOpen(...)` and the `accounting_period` open/closed model land here in the
 * `period-control` brief: posting / reverse into a closed period is rejected before a number is
 * consumed. No business logic ships in the scaffold.
 */
import { Module } from '@nestjs/common';

@Module({})
export class PeriodModule {}
