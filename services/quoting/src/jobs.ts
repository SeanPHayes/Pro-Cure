import { emit, hours, type Job, type Tx } from '@procure/platform';
import { todayIso } from './domain/pricing.js';
import { OPEN_STATUSES, type QuoteRow, recomputeLines } from './repo.js';
import { emitReminder } from './routes/cost-requests.js';

const REMINDER_EVERY_DAYS = 3;

/**
 * Recompute cost_expired / cost_expiring flags (they depend on today's date) for every open quote
 * and notify each tenant's procurement team about quotes with newly expiring/expired costs.
 */
export async function costExpirySweep(tx: Tx, now: Date) {
  const quotes = await tx<QuoteRow[]>`
    select * from quoting.quotes where not is_template and status in ${tx(OPEN_STATUSES)}`;
  const today = todayIso(now);
  const byTenant = new Map<string, { quote: QuoteRow; expiring: number; expired: number }[]>();
  let linesUpdated = 0;
  for (const q of quotes) {
    const r = await recomputeLines(tx, q, { today });
    linesUpdated += r.updated;
    if (!r.newlyFlagged.length) continue;
    const entry = {
      quote: q,
      expiring: r.newlyFlagged.filter((f) => f.flag === 'cost_expiring').length,
      expired: r.newlyFlagged.filter((f) => f.flag === 'cost_expired').length,
    };
    if (!byTenant.has(q.tenantId)) byTenant.set(q.tenantId, []);
    byTenant.get(q.tenantId)!.push(entry);
  }
  for (const [tenantId, entries] of byTenant) {
    const body = entries
      .map(
        (e) =>
          `${e.quote.number} ${e.quote.name}: ${[e.expired && `${e.expired} expired`, e.expiring && `${e.expiring} expiring`].filter(Boolean).join(', ')}`,
      )
      .join('\n');
    await emit(
      tx,
      'quoting',
      'cmd.notify',
      {
        userIds: [],
        roles: ['procurement'],
        title: `Vendor costs expiring on ${entries.length} quote(s)`,
        body,
        link: entries.length === 1 ? `/app/quotes/${entries[0]!.quote.id}` : '/app/quotes',
        severity: entries.some((e) => e.expired) ? 'warning' : 'info',
      },
      { tenantId, actor: null },
    );
  }
  return { quotes: quotes.length, linesUpdated, tenantsNotified: byTenant.size };
}

/** Remind vendors about overdue cost requests (at most once every 3 days per request). */
export async function costRequestReminders(tx: Tx, now: Date) {
  const due = await tx<
    {
      id: string;
      tenantId: string;
      number: string;
      vendorEmail: string | null;
      dueDate: string | null;
      documentId: string | null;
      projectName: string | null;
    }[]
  >`
    select id, tenant_id, number, vendor_email, due_date, document_id, project_name from quoting.cost_requests
    where status in ('sent', 'viewed') and due_date is not null and due_date < ${todayIso(now)}::date
      and vendor_email is not null
      and (last_reminded_at is null or last_reminded_at < ${now.toISOString()}::timestamptz - make_interval(days => ${REMINDER_EVERY_DAYS}))`;
  let sent = 0;
  for (const cr of due) {
    const ok = await emitReminder(
      tx,
      (type, data) => emit(tx, 'quoting', type, data, { tenantId: cr.tenantId, actor: null }),
      cr,
    );
    if (ok) sent++;
  }
  return { overdue: due.length, sent };
}

export const jobs: Job[] = [
  { name: 'cost-expiry-sweep', everyMs: hours(6), run: ({ tx, now }) => costExpirySweep(tx, now) },
  { name: 'cost-request-reminders', everyMs: hours(24), run: ({ tx, now }) => costRequestReminders(tx, now) },
];
