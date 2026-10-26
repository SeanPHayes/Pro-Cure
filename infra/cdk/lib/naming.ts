import type { StageConfig } from '../config/index.js';
import type { ServiceName } from './services.js';

/** Resource naming in one place so CI scripts and docs can rely on it. */
export const names = (cfg: StageConfig) => {
  const s = cfg.stage;
  return {
    stack: (part: string) => `ProCure-${s}-${part}`,
    ecrRepo: (svc: ServiceName | 'tools') => `pro-cure/${svc}`,
    eventBus: `pro-cure-${s}`,
    queue: (svc: ServiceName) => `pro-cure-${s}-${svc}`,
    dlq: (svc: ServiceName) => `pro-cure-${s}-${svc}-dlq`,
    cluster: `pro-cure-${s}`,
    opsCluster: `pro-cure-${s}-ops`,
    migrateFamily: `pro-cure-${s}-migrate`,
    namespace: 'procure.internal',
    secret: (part: string) => `pro-cure/${s}/${part}`,
    logGroup: (part: string) => `/pro-cure/${s}/${part}`,
    dbName: 'procure',
  };
};

/** Internal URL of a service over Cloud Map DNS. */
export const internalUrl = (svc: ServiceName, port: number) => `http://${svc}.procure.internal:${port}`;
