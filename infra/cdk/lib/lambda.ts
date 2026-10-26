import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '../../..');
const CDK_NODE_MODULES = join(here, '../node_modules');

/**
 * Node 22 ARM64 Lambda from infra/lambda/<name>/index.ts, bundled with the locally installed esbuild
 * (no Docker). Third-party deps (e.g. `postgres`) resolve from infra/cdk/node_modules via NODE_PATH;
 * the AWS SDK v3 is provided by the runtime and left external.
 */
export function procureLambda(
  scope: Construct,
  id: string,
  name: string,
  props: Omit<nodejs.NodejsFunctionProps, 'entry' | 'runtime' | 'projectRoot' | 'depsLockFilePath'> = {},
) {
  const entry = join(REPO_ROOT, 'infra/lambda', name, 'index.ts');
  if (!existsSync(entry)) throw new Error(`Lambda source missing: ${entry}`);
  return new nodejs.NodejsFunction(scope, id, {
    entry,
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 256,
    timeout: Duration.seconds(30),
    projectRoot: REPO_ROOT,
    depsLockFilePath: join(REPO_ROOT, 'pnpm-lock.yaml'),
    ...props,
    bundling: {
      format: nodejs.OutputFormat.ESM,
      target: 'node22',
      minify: true,
      sourceMap: true,
      forceDockerBundling: false,
      environment: { NODE_PATH: CDK_NODE_MODULES },
      banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      ...props.bundling,
    },
  });
}
