// Guard for db:reset / db:seed. A running `pnpm dev` stack relays outbox events itself; after a reset its
// subscription registry is gone, so it would publish the seed's events to nobody and the seed's
// cross-service effects (deposit invoices, threads, task updates…) would silently be lost.
import net from 'node:net';

const ports = [8080, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009];
const inUse = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

const busy = [];
for (const p of ports) if (await inUse(p)) busy.push(p);
if (busy.length && !process.env.FORCE) {
  console.error(
    `Pro-Cure services are running (ports ${busy.join(', ')}). Stop \`pnpm dev\` first, then re-run.\n` +
      'Set FORCE=1 to skip this check.',
  );
  process.exit(1);
}
