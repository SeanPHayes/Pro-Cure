import type { EventHandler } from '@procure/platform';

/** pino Logger as exposed by the platform (comms does not depend on pino directly). */
export type Logger = Parameters<EventHandler>[1]['log'];
