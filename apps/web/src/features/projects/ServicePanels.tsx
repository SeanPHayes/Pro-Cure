import type { ServiceName } from '@procure/domain';
import { useQuery } from '@tanstack/react-query';
import { CloudOff, FileSpreadsheet, Package } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { DocumentsPanel } from '@/components/shared/DocumentsPanel';
import { ThreadPanel } from '@/components/shared/ThreadPanel';
import { EmptyState, EscalationMark, Loading, Section, Stat, StatusBadge } from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, money, moneyShort, pct } from '@/lib/format';

/**
 * Panels backed by other services (quoting, orders, finance, documents, comms). Each one probes its
 * service quietly and shows a calm "not available" state instead of erroring when it isn't running.
 */
export function Unavailable({ what, children }: { what: string; children?: ReactNode }) {
  return (
    <EmptyState icon={<CloudOff />} title={`${what} aren’t available right now`}>
      {children ?? 'This part of Pro-Cure is still being connected. Check back shortly — nothing is lost.'}
    </EmptyState>
  );
}

/** Quiet probe: resolves true when the service answers the same request the panel will make. */
export function useServiceProbe(
  service: ServiceName,
  path: string,
  query?: Record<string, string | undefined>,
) {
  return useQuery({
    queryKey: ['probe', service, path, query],
    queryFn: () => api.get(service, path, query).then(() => true),
    retry: false,
    meta: { silent: true },
    staleTime: 60_000,
  });
}

// ------------------------------------------------------------------ Quotes
interface QuoteRow {
  id: string;
  number: string;
  name: string;
  phase: string | null;
  status: string;
  sentAt: string | null;
  updatedAt?: string;
  totals?: { lineCount: number; sellSubtotal: number; grandTotal: number; marginPct: number | null };
}

export function ProjectQuotes({ projectId }: { projectId: string }) {
  const s = useSession();
  const nav = useNavigate();
  const costs = hasPerm(s, 'quotes:costs:read');
  const q = useQuery({
    queryKey: ['quoting', 'quotes', { projectId }],
    queryFn: () => api.get<Page<QuoteRow>>('quoting', '/quotes', { projectId, limit: 100 }),
    retry: false,
    meta: { silent: true },
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <Unavailable what="Quotes" />;
  const cols: Column<QuoteRow>[] = [
    {
      key: 'number',
      header: 'Number',
      cell: (r) => <span className="num whitespace-nowrap text-ink-2">{r.number}</span>,
    },
    {
      key: 'name',
      header: 'Quote',
      cell: (r) => (
        <div>
          <div className="font-[560]">{r.name}</div>
          {r.phase && <div className="text-[12px] text-ink-3">{r.phase}</div>}
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'lines', header: 'Lines', align: 'right', cell: (r) => r.totals?.lineCount ?? '—' },
    { key: 'total', header: 'Total', align: 'right', cell: (r) => money(r.totals?.grandTotal) },
    ...(costs
      ? [
          {
            key: 'margin',
            header: 'Margin',
            align: 'right' as const,
            cell: (r: QuoteRow) => pct(r.totals?.marginPct),
          },
        ]
      : []),
    {
      key: 'sent',
      header: 'Sent',
      cell: (r) => <span className="num whitespace-nowrap">{date(r.sentAt)}</span>,
    },
  ];
  return (
    <Section
      title="Quotes"
      bodyClassName=""
      actions={
        <Link className="text-[13px] font-[560] text-lacquer hover:underline" to="/app/quotes">
          All quotes
        </Link>
      }
    >
      <DataTable
        columns={cols}
        rows={q.data?.items}
        onRowClick={(r) => nav(`/app/quotes/${r.id}`)}
        empty={
          <EmptyState icon={<FileSpreadsheet />} title="No quotes for this project yet">
            Start a quote from the Quotes page and link it to this project.
          </EmptyState>
        }
      />
    </Section>
  );
}

// ------------------------------------------------------------------ Orders
interface PoRow {
  id: string;
  number: string;
  vendorName?: string;
  status: string;
  escalation?: string;
  escalationLevel?: string;
  total?: number;
  issuedAt?: string | null;
  requiredDeliveryDate?: string | null;
  expectedShipDate?: string | null;
}

export function ProjectOrders({ projectId }: { projectId: string }) {
  const nav = useNavigate();
  const q = useQuery({
    queryKey: ['orders', 'purchase-orders', { projectId }],
    queryFn: () => api.get<Page<PoRow>>('orders', '/purchase-orders', { projectId, limit: 200 }),
    retry: false,
    meta: { silent: true },
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <Unavailable what="Purchase orders" />;
  const rows = q.data?.items ?? [];
  const total = rows.reduce((a, r) => a + (r.total ?? 0), 0);
  const cols: Column<PoRow>[] = [
    {
      key: 'number',
      header: 'PO',
      cell: (r) => <span className="num font-[560] whitespace-nowrap">{r.number}</span>,
    },
    { key: 'vendor', header: 'Vendor', cell: (r) => r.vendorName ?? '—' },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'risk',
      header: 'Risk',
      cell: (r) => <EscalationMark level={r.escalation ?? r.escalationLevel} />,
    },
    {
      key: 'issued',
      header: 'Issued',
      cell: (r) => <span className="num whitespace-nowrap">{date(r.issuedAt)}</span>,
    },
    {
      key: 'delivery',
      header: 'Required delivery',
      cell: (r) => <span className="num whitespace-nowrap">{date(r.requiredDeliveryDate)}</span>,
    },
    { key: 'total', header: 'Total', align: 'right', cell: (r) => money(r.total) },
  ];
  return (
    <Section
      title={
        <span>
          Purchase orders{' '}
          <span className="num ml-1 font-[520] text-ink-3">
            {rows.length} · {moneyShort(total)}
          </span>
        </span>
      }
      bodyClassName=""
    >
      <DataTable
        columns={cols}
        rows={rows}
        onRowClick={(r) => nav(`/app/orders/${r.id}`)}
        empty={
          <EmptyState icon={<Package />} title="No purchase orders yet">
            Purchase orders appear here once an approved quote is ordered.
          </EmptyState>
        }
      />
    </Section>
  );
}

// ------------------------------------------------------------------ Financials
interface Financials {
  contractValue: number;
  estimatedCost: number;
  committedCost: number;
  invoiced: number;
  collected: number;
  arBalance: number;
  overdueAr: number;
  apBilled: number;
  apPaid: number;
  apOpen: number;
  depositsCollected: number;
  uninvoicedContract: number;
  projectedMarginPct: number | null;
  actualMarginToDate: number;
  warnings: string[];
}

export function ProjectFinancials({ projectId, budget }: { projectId: string; budget: number | null }) {
  const q = useQuery({
    queryKey: ['finance', 'project', projectId],
    queryFn: () => api.get<Financials>('finance', `/projects/${projectId}/financials`),
    retry: false,
    meta: { silent: true },
  });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Unavailable what="Financials" />;
  const f = q.data;
  return (
    <div className="space-y-4">
      {f.warnings.length > 0 && (
        <ul className="space-y-1 rounded-sm border border-warn/30 bg-warn-50 px-3 py-2 text-[13px] text-warn">
          {f.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <Section title="Contract">
        <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
          <Stat
            label="Contract value"
            value={moneyShort(f.contractValue)}
            note={budget ? `Budget ${moneyShort(budget)}` : undefined}
          />
          <Stat
            label="Committed cost"
            value={moneyShort(f.committedCost)}
            note={`Estimated ${moneyShort(f.estimatedCost)}`}
          />
          <Stat label="Projected margin" value={pct(f.projectedMarginPct)} tone="lacquer" />
          <Stat label="Margin to date" value={moneyShort(f.actualMarginToDate)} />
        </div>
      </Section>
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Receivables (owner)">
          <div className="grid grid-cols-2 gap-5">
            <Stat
              label="Invoiced"
              value={moneyShort(f.invoiced)}
              note={`${moneyShort(f.uninvoicedContract)} not yet invoiced`}
            />
            <Stat
              label="Collected"
              value={moneyShort(f.collected)}
              note={`Deposits ${moneyShort(f.depositsCollected)}`}
            />
            <Stat label="Open balance" value={moneyShort(f.arBalance)} />
            <Stat
              label="Overdue"
              value={moneyShort(f.overdueAr)}
              tone={f.overdueAr > 0 ? 'crit' : undefined}
            />
          </div>
        </Section>
        <Section title="Payables (vendors)">
          <div className="grid grid-cols-2 gap-5">
            <Stat label="Billed" value={moneyShort(f.apBilled)} />
            <Stat label="Paid" value={moneyShort(f.apPaid)} />
            <Stat label="Open" value={moneyShort(f.apOpen)} />
          </div>
        </Section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Files & messages (guarded shared panels)
export function ProjectFiles({ projectId }: { projectId: string }) {
  const probe = useServiceProbe('documents', '/documents', { entityType: 'project', entityId: projectId });
  if (probe.isLoading) return <Loading />;
  if (probe.isError) return <Unavailable what="Files" />;
  return <DocumentsPanel entityType="project" entityId={projectId} />;
}

export function GuardedThread({
  projectId,
  visibility,
  clientOrgId,
  emptyHint,
}: {
  projectId: string;
  visibility: 'internal' | 'client';
  clientOrgId?: string | null;
  emptyHint?: string;
}) {
  const probe = useServiceProbe('comms', '/threads/for', {
    entityType: 'project',
    entityId: projectId,
    visibility,
    clientOrgId: clientOrgId ?? undefined,
  });
  if (probe.isLoading) return <Loading />;
  if (probe.isError) return <Unavailable what="Messages" />;
  return (
    <ThreadPanel
      entityType="project"
      entityId={projectId}
      visibility={visibility}
      clientOrgId={clientOrgId}
      allowEmail={visibility === 'client'}
      emptyHint={emptyHint}
    />
  );
}
