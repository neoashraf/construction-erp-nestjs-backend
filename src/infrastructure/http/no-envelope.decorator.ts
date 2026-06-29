/**
 * @NoEnvelope() — opt a route (or whole controller) OUT of the central `{ data, meta }` success
 * envelope (overview §6). For endpoints whose body shape is fixed by an external contract and must not
 * be wrapped — e.g. the Terminus health check (liveness/readiness probes expect its own shape). The
 * error path (exception filter) still applies; only the success interceptor is skipped.
 */
import { SetMetadata } from '@nestjs/common';

export const NO_ENVELOPE = 'noEnvelope';
export const NoEnvelope = () => SetMetadata(NO_ENVELOPE, true);
