#!/usr/bin/env node
// Runs every service, the local gateway and the web app with live reload.
//   pnpm dev                 # everything
//   pnpm dev quoting orders  # only these services (+ gateway + web)
//   pnpm dev --no-web
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['identity', 'catalog', 'documents', 'projects', 'quoting', 'orders', 'finance', 'comms', 'ai'];

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const services = (only.length ? only : ALL).filter((s) =>
  existsSync(join(root, 'services', s, 'package.json')),
);
const withWeb = !args.includes('--no-web') && existsSync(join(root, 'apps/web/package.json'));

// .env (optional) then local defaults.
const env = { ...process.env };
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const defaults = {
  APP_ENV: 'local',
  AUTH_DEV_LOGIN: 'true',
  AUTH_KEYS_DIR: join(root, '.local-storage/keys'),
  STORAGE_LOCAL_DIR: join(root, '.local-storage/files'),
  FORCE_COLOR: '1',
};
for (const [k, v] of Object.entries(defaults)) env[k] ??= v;

const colors = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96];
const procs = [];
const run = (name, cwd, cmd, cmdArgs, i) => {
  const color = colors[i % colors.length];
  const tag = `\x1b[${color}m${name.padEnd(10)}\x1b[0m│ `;
  const p = spawn(cmd, cmdArgs, { cwd, env, shell: process.platform === 'win32' });
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(tag + l + '\n');
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => process.stdout.write(`${tag}exited with code ${code}\n`));
  procs.push(p);
};

const tsx = join(root, 'node_modules/.bin/tsx');
services.forEach((s, i) =>
  run(s, join(root, 'services', s), tsx, ['watch', '--clear-screen=false', 'src/main.ts'], i),
);
run(
  'gateway',
  join(root, 'services/gateway'),
  tsx,
  ['watch', '--clear-screen=false', 'src/main.ts'],
  services.length,
);
if (withWeb) run('web', join(root, 'apps/web'), 'pnpm', ['dev'], services.length + 1);

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`\nPro-Cure dev: ${services.join(', ')} + gateway${withWeb ? ' + web' : ''}`);
console.log('  API gateway  http://localhost:8080/api');
if (withWeb) console.log('  Web app      http://localhost:5173\n');
