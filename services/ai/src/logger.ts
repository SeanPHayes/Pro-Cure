import type { rootLogger } from '@procure/platform';

/** pino Logger type, without a direct dependency on pino. */
export type Logger = ReturnType<typeof rootLogger>;
