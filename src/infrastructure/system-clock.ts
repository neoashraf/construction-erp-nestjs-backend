/**
 * SystemClock — the `Clock` port adapter backed by the real wall clock. INFRASTRUCTURE.
 */
import { Injectable } from '@nestjs/common';
import { Clock } from '../common/ports/clock.port';

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
