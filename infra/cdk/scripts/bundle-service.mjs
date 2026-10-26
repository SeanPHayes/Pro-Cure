#!/usr/bin/env node
// Production bundler used by services/Dockerfile.
//
// Why not the services' own `build` script? It runs esbuild with `--packages=external`, which leaves the
// workspace packages (@procure/domain, @procure/platform) external. Those packages ship raw TypeScript
// with `.js` import specifiers, which plain `node` cannot load. This script bundles the service entry
// together with every `@procure/*` workspace package and keeps third-party npm packages external
// (they come from `pnpm deploy --prod` node_modules in the image).
//
// Usage:
//   node infra/cdk/scripts/bundle-service.mjs <service>          → services/<service>/dist/main.js
//   node infra/cdk/scripts/bundle-service.mjs tools              → dist-tools/migrate.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * esbuild comes from infra/cdk's devDependencies when present (local/CI); inside the Docker builder,
 * where only the service and the root workspace are installed, it is resolved through the root's
 * `tsx` dependency (tsx depends on esbuild).
 */
async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    const rootRequire = createRequire(join(root, 'package.json'));
    const tsxRequire = createRequire(rootRequire.resolve('tsx/package.json'));
    return import(pathToFileURL(tsxRequire.resolve('esbuild')).href);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const { build } = await loadEsbuild();
const target = process.argv[2];
if (!target || !/^[a-z-]+$/.test(target)) {
  console.error('usage: bundle-service.mjs <service|tools>');
  process.exit(2);
}

const entries =
  target === 'tools'
    ? // Emitted one level below the repo root so tools/migrate.ts's `join(dirname(import.meta.url), '..')`
      // still resolves to the root that contains packages/ and services/.
      { entry: join(root, 'tools/migrate.ts'), outfile: join(root, 'dist-tools/migrate.mjs') }
    : {
        entry: join(root, 'services', target, 'src/main.ts'),
        outfile: join(root, 'services', target, 'dist/main.js'),
      };

/** Externalize every bare import except @procure/* (workspace TypeScript gets inlined). */
const externalizeThirdParty = {
  name: 'externalize-third-party',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@procure/')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: [entries.entry],
  outfile: entries.outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  plugins: [externalizeThirdParty],
  // Some CJS dependencies call require(); give ESM output a require() for safety.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
