import { dev } from './dev.js';
import { prod } from './prod.js';
import { staging } from './staging.js';
import type { StageConfig, StageName } from './types.js';

export type { StageConfig, StageName, TaskSizing } from './types.js';

const STAGES: Record<StageName, StageConfig> = { dev, staging, prod };

/**
 * Resolve the stage config. `account` / `region` can be overridden with `-c account=… -c region=…`
 * (CI passes the real account); otherwise CDK_DEFAULT_ACCOUNT/REGION, then the placeholder in the file.
 */
export function loadConfig(
  stage: string,
  overrides: { account?: string; region?: string } = {},
): StageConfig {
  if (!(stage in STAGES)) throw new Error(`Unknown stage "${stage}" (expected dev | staging | prod)`);
  const base = STAGES[stage as StageName];
  return {
    ...base,
    account: overrides.account ?? process.env.CDK_DEFAULT_ACCOUNT ?? base.account,
    region: overrides.region ?? base.region,
  };
}
