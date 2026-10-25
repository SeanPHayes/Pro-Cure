import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ClipboardCheck, PackageCheck, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState, Loading, ProgressBar, Section } from '@/components/ui';
import { DueLabel, needsResponse, useVendorRequests } from '@/features/quoting/vendorShared';
import { api, type Page } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { date } from '@/lib/format';

interface ClaimLite {
  id: string;
  number: string;
  status: string;
  title?: string;
}
interface PoLite {
  id: string;
  number: string;
  status: string;
  projectName?: string | null;
  requestedDeliveryDate?: string | null;
}

export function Component() {
  const s = useMe();
  const firm = s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ?? 'your client';
  const req = useVendorRequests();
  const pos = useQuery({
    queryKey: ['vendor', 'pos', 'home'],
    queryFn: () => api.get<Page<PoLite> | PoLite[]>('orders', '/vendor/purchase-orders', { limit: 5 }),
    select: (d) => (Array.isArray(d) ? d : (d?.items ?? [])).slice(0, 5),
    retry: false,
    meta: { silent: true },
  });
  const claims = useQuery({
    queryKey: ['vendor', 'claims', 'home'],
    queryFn: () => api.get<Page<ClaimLite> | ClaimLite[]>('orders', '/vendor/claims', { limit: 5 }),
    select: (d) => (Array.isArray(d) ? d : (d?.items ?? [])).slice(0, 5),
    retry: false,
    meta: { silent: true },
  });
  const open = (req.data?.items ?? [])
    .filter(needsResponse)
    .sort((a, b) => (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'));

  return (
    <div className="mx-auto max-w-[980px] px-4 py-6 sm:px-6">
      <h1 className="text-[24px] font-[640]">Welcome, {s.user.name.split(' ')[0]}</h1>
      <p className="mt-1 max-w-[64ch] text-ink-2">
        This is your portal for working with <b className="font-[600] text-ink">{firm}</b>. They’ll send you
        pricing requests for hotel projects here, and purchase orders once items are approved.
      </p>

      <Section
        className="mt-6"
        title={`Pricing requests waiting for you${open.length ? ` (${open.length})` : ''}`}
        bodyClassName=""
      >
        {req.isLoading ? (
          <Loading />
        ) : !open.length ? (
          <EmptyState icon={<ClipboardCheck />} title="Nothing waiting for your prices">
            When {firm} asks you to price items, the request shows up here and you’ll get an email.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line-2">
            {open.map((r) => (
              <li key={r.id}>
                <Link
                  to={`/vendor/cost-requests/${r.id}`}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-stone"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-[600]">{r.projectName ?? 'Hotel project'}</div>
                    <div className="num text-[13px] text-ink-2">
                      {r.number} · {r.lineCount} {r.lineCount === 1 ? 'item' : 'items'} to price
                    </div>
                  </div>
                  <div className="hidden w-36 sm:block">
                    <div className="num mb-1 text-[12px] text-ink-3">
                      {r.respondedLineCount}/{r.lineCount} priced
                    </div>
                    <ProgressBar
                      value={(r.respondedLineCount / Math.max(1, r.lineCount)) * 100}
                      tone="brass"
                    />
                  </div>
                  <div className="text-right text-[13px]">
                    <div className="text-[12px] text-ink-3">Due</div>
                    <DueLabel r={r} />
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-sm bg-lacquer px-3 py-1.5 text-[13px] font-[560] text-white">
                    {r.respondedLineCount ? 'Continue' : 'Start pricing'}
                    <ChevronRight className="size-4" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {pos.isSuccess && (
          <Section
            title="Recent purchase orders"
            bodyClassName=""
            actions={
              <Link to="/vendor/orders" className="text-[13px] font-[560] text-lacquer hover:underline">
                All orders
              </Link>
            }
          >
            {!pos.data.length ? (
              <EmptyState icon={<PackageCheck />} title="No purchase orders yet">
                Approved items become purchase orders here for you to acknowledge.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line-2">
                {pos.data.map((p) => (
                  <li key={p.id}>
                    <Link
                      to={`/vendor/orders/${p.id}`}
                      className="flex justify-between gap-3 px-4 py-2.5 hover:bg-stone"
                    >
                      <span>
                        <span className="num font-[600]">{p.number}</span>
                        <span className="ml-2 text-ink-2">{p.projectName}</span>
                      </span>
                      <span className="num shrink-0 whitespace-nowrap text-[13px] text-ink-3">
                        {date(p.requestedDeliveryDate)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
        {claims.isSuccess && (
          <Section
            title="Open claims"
            bodyClassName=""
            actions={
              <Link to="/vendor/claims" className="text-[13px] font-[560] text-lacquer hover:underline">
                All claims
              </Link>
            }
          >
            {!claims.data.length ? (
              <EmptyState icon={<ShieldAlert />} title="No claims">
                If something arrives damaged or wrong, the claim and photos appear here.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line-2">
                {claims.data.map((c) => (
                  <li key={c.id} className="flex justify-between gap-3 px-4 py-2.5">
                    <span className="num font-[600]">{c.number}</span>
                    <span className="text-ink-2">{c.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>

      <Section className="mt-4" title="How pricing requests work">
        <ol className="grid gap-4 text-[13px] text-ink-2 sm:grid-cols-3">
          <li>
            <div className="mb-1 font-[620] text-ink">1. Open a request</div>
            See each item with its finish, dimensions and quantity.
          </li>
          <li>
            <div className="mb-1 font-[620] text-ink">2. Enter your prices</div>
            Unit cost, how long it’s valid, and lead time. Spot a spec mistake? Suggest a correction.
          </li>
          <li>
            <div className="mb-1 font-[620] text-ink">3. Submit</div>
            {firm} is notified. You can still update prices until they close the request.
          </li>
        </ol>
      </Section>
    </div>
  );
}
