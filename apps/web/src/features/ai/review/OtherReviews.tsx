import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Mail } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, cx, Facts, Section, StatusBadge } from '@/components/ui';
import { api, documentUrl } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { count, date, humanize, money } from '@/lib/format';
import { PdfPageViewer } from '../PdfPageViewer';
import {
  aiKeys,
  Confidence,
  type DrawingSplitOutput,
  type InboxOutput,
  type Job,
  type RiskOutput,
} from '../shared';
import { applyErrorText, Banner, Warnings } from './common';

// ------------------------------------------------------------------ Drawing split
const UNASSIGNED = '';

export function DrawingSplitReview({ job, readOnly }: { job: Job; readOnly: boolean }) {
  const s = useSession();
  const qc = useQueryClient();
  const out = job.output as unknown as DrawingSplitOutput;
  const documentId = job.input.documentId as string;
  const [page, setPage] = useState(1);
  // page → specId ('' = unassigned). Start from the saved review groups, else the model's groups.
  const [assign, setAssign] = useState<Record<number, string>>(() => {
    const groups = (job.review?.groups as { specId: string; pages: number[] }[] | undefined) ?? out.groups;
    const m: Record<number, string> = {};
    for (let p = 1; p <= out.pageCount; p++) m[p] = UNASSIGNED;
    for (const g of groups) for (const p of g.pages) m[p] = g.specId;
    return m;
  });
  const [dirty, setDirty] = useState(false);
  const byPage = new Map(out.pageAssignments.map((a) => [a.page, a]));
  const candidates = new Map(out.candidates.map((c) => [c.id, c]));
  const groups = useMemo(() => {
    const g = new Map<string, number[]>();
    for (const [p, sid] of Object.entries(assign)) if (sid) g.set(sid, [...(g.get(sid) ?? []), Number(p)]);
    return [...g.entries()]
      .map(([specId, pages]) => ({ specId, pages: pages.sort((a, b) => a - b) }))
      .sort((a, b) => a.pages[0]! - b.pages[0]!);
  }, [assign]);
  const unassigned = Object.entries(assign)
    .filter(([, v]) => !v)
    .map(([p]) => Number(p));
  const groupBody = () =>
    groups.map((g) => ({
      specId: g.specId,
      pages: g.pages,
      name: candidates.get(g.specId)?.name,
      code: candidates.get(g.specId)?.code,
    }));

  const save = useMutation({
    mutationFn: () =>
      api.post<Job>('ai', `/jobs/${job.id}/review`, {
        review: { groups: groupBody().map(({ specId, pages, name }) => ({ specId, pages, name })) },
      }),
    onSuccess: (j) => {
      setDirty(false);
      qc.setQueryData(aiKeys.job(job.id), j);
      toast.success('Review saved');
    },
  });
  const [applyError, setApplyError] = useState<string | null>(
    job.applyError ? applyErrorText(new Error(job.applyError)) : null,
  );
  const apply = useMutation({
    mutationFn: () => {
      setApplyError(null);
      return api.post<Job>('ai', `/jobs/${job.id}/apply`, { groups: groupBody() });
    },
    onSuccess: (j) => {
      qc.setQueryData(aiKeys.job(job.id), j);
      qc.invalidateQueries({ queryKey: ['ai', 'jobs'] });
      toast.success(`${groups.length} drawings filed to specs`);
    },
    onError: (e) => {
      setApplyError(applyErrorText(e));
      qc.invalidateQueries({ queryKey: aiKeys.job(job.id) });
    },
  });
  const applied =
    job.status === 'applied'
      ? (job.applyResult?.documents as
          | { specId: string; documentId: string; filename: string; pages: number[] }[]
          | undefined)
      : undefined;
  const specOptions = [
    { value: UNASSIGNED, label: 'Not a drawing / skip' },
    ...out.candidates.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })),
  ];

  return (
    <div className="space-y-5">
      {applied && (
        <Banner tone="ok" title={`${applied.length} line drawings filed to specs`}>
          <ul className="mt-1 space-y-0.5">
            {applied.map((d) => (
              <li key={d.documentId}>
                <a
                  href={documentUrl(d.documentId)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-lacquer hover:underline"
                >
                  {d.filename}
                </a>{' '}
                <span className="text-ink-3">pages {d.pages.join(', ')}</span>
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {!readOnly && <Warnings items={out.warnings} />}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="space-y-4">
          <Section
            title={
              <span>
                Pages{' '}
                <span className="num font-normal text-ink-3">
                  {out.pageCount} in {out.filename}
                </span>
              </span>
            }
            bodyClassName="p-0"
          >
            <ol className="divide-y divide-line-2">
              {Array.from({ length: out.pageCount }, (_, i) => i + 1).map((p) => {
                const a = byPage.get(p);
                const sid = assign[p] ?? '';
                return (
                  <li
                    key={p}
                    className={cx('flex flex-wrap items-center gap-3 px-4 py-2', page === p && 'bg-brass-50')}
                  >
                    <button
                      type="button"
                      onClick={() => setPage(p)}
                      aria-label={`Show page ${p}`}
                      className={cx(
                        'num grid h-12 w-9 shrink-0 place-items-center rounded-xs border text-[12px] font-[600]',
                        page === p
                          ? 'border-brass bg-paper text-brass'
                          : 'border-line bg-stone text-ink-2 hover:border-ink-4',
                      )}
                    >
                      {p}
                    </button>
                    <div className="min-w-[200px] flex-1">
                      {readOnly ? (
                        <span className="font-[560]">
                          {sid ? `${candidates.get(sid)?.code} — ${candidates.get(sid)?.name}` : 'Skipped'}
                        </span>
                      ) : (
                        <select
                          aria-label={`Spec for page ${p}`}
                          value={sid}
                          onChange={(e) => {
                            setAssign({ ...assign, [p]: e.target.value });
                            setDirty(true);
                          }}
                          className={cx(
                            'h-8 w-full rounded-sm border bg-paper px-2 focus:border-lacquer focus:outline-none',
                            sid ? 'border-line' : 'border-warn/40 text-ink-3',
                          )}
                        >
                          {specOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      )}
                      {a && a.reasons.length > 0 && (
                        <div className="mt-0.5 text-[12px] text-ink-3">{a.reasons.join(' · ')}</div>
                      )}
                    </div>
                    {a && a.specId === sid && sid && <Confidence value={a.score} />}
                    {a && (a.specId ?? '') !== sid && <Badge tone="brass">Changed</Badge>}
                  </li>
                );
              })}
            </ol>
          </Section>
          <Section title={`Drawings to file (${groups.length})`}>
            {!groups.length ? (
              <p className="text-ink-3">Assign at least one page to a spec.</p>
            ) : (
              <ul className="space-y-2">
                {groups.map((g) => {
                  const c = candidates.get(g.specId);
                  return (
                    <li key={g.specId} className="flex flex-wrap items-center gap-2">
                      <span className="num font-[600]">{c?.code}</span>
                      <span className="min-w-0 flex-1 truncate">{c?.name}</span>
                      <span className="flex gap-1">
                        {g.pages.map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setPage(p)}
                            className="num h-6 rounded-xs bg-stone-2 px-1.5 text-[12px] font-[560] text-ink-2 hover:bg-line"
                          >
                            p.{p}
                          </button>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {unassigned.length > 0 && (
              <p className="mt-3 text-[13px] text-ink-3">
                Skipped pages: <span className="num">{unassigned.join(', ')}</span>
              </p>
            )}
          </Section>
        </div>
        <PdfPageViewer
          documentId={documentId}
          page={page}
          pageCount={out.pageCount}
          onPage={setPage}
          className="h-[70vh] xl:sticky xl:top-4"
        />
      </div>
      {!readOnly && (
        <Section>
          {applyError && (
            <div className="mb-3">
              <Banner tone="crit" title="Not applied">
                {applyError}
              </Banner>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-[13px] text-ink-2">
              Each spec gets one PDF line drawing, included in its spec book. The original packet is
              unchanged.
            </p>
            <Button variant="ghost" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save review
            </Button>
            {hasPerm(s, 'specs:write') && (
              <Button
                variant="primary"
                disabled={!groups.length}
                loading={apply.isPending}
                onClick={() => apply.mutate()}
              >
                File {groups.length} {groups.length === 1 ? 'drawing' : 'drawings'}
              </Button>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Inbox routing
export function InboxReview({ job }: { job: Job }) {
  const o = job.output as unknown as InboxOutput;
  const x = o.extracted;
  return (
    <div className="space-y-5">
      <Banner
        tone={o.routed ? 'ok' : 'info'}
        icon={<Mail />}
        title={
          o.routed
            ? `Filed to ${o.target?.poNumber} automatically`
            : o.target
              ? `Suggested for ${o.target.poNumber} — waiting for a person in the inbox`
              : 'Couldn’t tell which purchase order this is about — waiting for a person in the inbox'
        }
        actions={
          <>
            {o.target && (
              <Link to={`/app/orders/${o.target.entityId}`}>
                <Button size="sm" icon={<ArrowUpRight className="size-4" />}>
                  Open {o.target.poNumber}
                </Button>
              </Link>
            )}
            <Link to="/app/inbox">
              <Button size="sm">Open inbox</Button>
            </Link>
          </>
        }
      >
        {o.routeError
          ? `Routing failed: ${o.routeError}`
          : `Emails at or above 85% confidence are filed without waiting.`}
      </Banner>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="What the email is">
          <Facts
            cols={2}
            items={[
              { label: 'Intent', value: humanize(o.intent) },
              { label: 'Confidence', value: <Confidence value={o.confidence} /> },
              { label: 'Vendor', value: o.vendor?.name ?? 'Not recognised' },
              { label: 'PO numbers mentioned', value: x.poNumbers.length ? x.poNumbers.join(', ') : 'None' },
              ...(x.trackingNumber
                ? [{ label: 'Tracking', value: `${x.carrier ?? ''} ${x.trackingNumber}`.trim() }]
                : []),
              ...(x.shipDate ? [{ label: 'Ship date', value: date(x.shipDate) }] : []),
              ...(x.newShipDate ? [{ label: 'New ship date', value: date(x.newShipDate) }] : []),
              ...(x.amount != null ? [{ label: 'Amount', value: money(x.amount) }] : []),
            ]}
          />
          {o.reasons.length > 0 && (
            <ul className="mt-4 list-disc space-y-0.5 border-t border-line-2 pt-3 pl-5 text-[13px] text-ink-2">
              {o.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Suggested next steps">
          {!o.suggestions.length ? (
            <p className="text-ink-3">No updates to suggest for this email.</p>
          ) : (
            <ul className="space-y-2">
              {o.suggestions.map((sg) => (
                <li key={sg.label} className="flex items-start gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brass" />
                  {sg.label}
                </li>
              ))}
            </ul>
          )}
          {o.suggestions.length > 0 && (
            <p className="mt-3 text-[12px] text-ink-3">Apply these from the email in the inbox.</p>
          )}
          {o.candidates.length > 1 && (
            <>
              <h3 className="mt-5 mb-1.5 text-[13px] font-[620] text-ink-2">
                Other purchase orders considered
              </h3>
              <ul className="divide-y divide-line-2 text-[13px]">
                {o.candidates.slice(0, 5).map((c) => (
                  <li key={c.poId} className="flex justify-between gap-3 py-1.5">
                    <Link to={`/app/orders/${c.poId}`} className="font-[560] hover:text-lacquer">
                      {c.poNumber}
                      <span className="ml-1.5 font-normal text-ink-3">
                        {[c.vendorName, c.projectName].filter(Boolean).join(' · ')}
                      </span>
                    </Link>
                    <span className="num text-ink-3">{Math.round(c.score * 100)}%</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Risk scoring
export function RiskReview({ job }: { job: Job }) {
  const raw = job.output as unknown as RiskOutput & { counts: { atRisk?: number } };
  // Stored JSON comes back camel-cased ("atRisk") from the job row; accept either spelling.
  const o: RiskOutput = {
    ...raw,
    counts: { ...raw.counts, at_risk: raw.counts.at_risk ?? raw.counts.atRisk ?? 0 },
  };
  const levels: [keyof RiskOutput['counts'], string, string][] = [
    ['critical', 'Critical', 'text-crit'],
    ['at_risk', 'At risk', 'text-risk'],
    ['watch', 'Watch', 'text-warn'],
    ['none', 'On track', 'text-ok'],
  ];
  return (
    <div className="space-y-5">
      {!o.postedToOrders && o.shipmentsScored > 0 && (
        <Banner tone="crit" title="Scores weren’t saved to purchase orders">
          {o.postError
            ? applyErrorText(new Error(`orders: ${o.postError}`))
            : 'Purchase orders didn’t accept the scores.'}
        </Banner>
      )}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-4">
        {levels.map(([k, l, tone]) => (
          <div key={k} className="bg-paper px-4 py-3">
            <div className="text-[12px] text-ink-3">{l}</div>
            <div className={cx('num text-[24px] font-[620]', o.counts[k] ? tone : 'text-ink-4')}>
              {count(o.counts[k])}
            </div>
          </div>
        ))}
      </div>
      {o.narrative && (
        <Section title="Summary">
          <p className="whitespace-pre-line text-ink-2">{o.narrative}</p>
        </Section>
      )}
      <Section title={`Shipments scored (${o.shipmentsScored})`} bodyClassName="p-0">
        {!o.scores?.length ? (
          <p className="px-4 py-6 text-ink-3">There were no open shipments to score.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table text-[13px]">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Shipment</th>
                  <th>Why</th>
                  <th className="right">Late probability</th>
                </tr>
              </thead>
              <tbody>
                {o.scores.slice(0, 50).map((x) => (
                  <tr key={x.shipmentId}>
                    <td>
                      <StatusBadge status={x.level} label={x.level === 'none' ? 'On track' : undefined} />
                    </td>
                    <td className="min-w-[200px]">
                      {x.poId ? (
                        <Link to={`/app/orders/${x.poId}`} className="font-[560] hover:text-lacquer">
                          {x.poNumber ?? x.label}
                        </Link>
                      ) : (
                        <span className="font-[560]">{x.label}</span>
                      )}
                      <div className="text-[12px] text-ink-3">
                        {[x.vendorName, x.projectName].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="min-w-[260px] text-ink-2">{x.reasons.join(' · ') || '—'}</td>
                    <td className="right num">{Math.round(x.probability * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
