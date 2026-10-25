import type { Job } from '@procure/platform';

/** The platform's logger type (pino), without depending on pino directly. */
export type Logger = Parameters<Job['run']>[0]['log'];
