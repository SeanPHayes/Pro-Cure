import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button, Checkbox, cx, Section } from '@/components/ui';
import { api } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, money } from '@/lib/format';
import { qk, type Vendor } from '../../catalog/shared';
import { PdfPageViewer } from '../PdfPageViewer';
import { aiKeys, Confidence, type Job, type QuoteMatch, type VendorQuoteOutput } from '../shared';
import { applyErrorText, Banner, CellInput, Warnings } from './common';

interface RowState {
  accepted: boolean;
  unitCost?: string;
  leadTimeWeeks?: string;
  expiresAt?: string;
}

const pctChange = (m: QuoteMatch) =>
  m.currentCost && m.unitCost != null ? ((m.unitCost - m.currentCost) / m.currentCost) * 100 : null;

export function VendorQuoteReview({ job, readOnly }: { job: Job; readOnly: boolean }) {
  const s = useSession();
  const qc = useQueryClient();
  const out = job.output as unknown as VendorQuoteOutput;
  const documentId = job.input.documentId as string;
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<RowState[]>(() => {
    const saved = new Map(
      (
        (job.review?.items as { index: number; accepted?: boolean; edits?: Record<string, unknown> }[]) ?? []
      ).map((r) => [r.index, r]),
    );
    return out.matches.map((m, i) => {
      const r = saved.get(i);
      const e = r?.edits ?? {};
      return {
        accepted: r ? r.accepted !== false : m.unitCost != null && !m.flags.length && m.confidence >= 0.5,
        unitCost: e.unitCost != null ? String(e.unitCost) : undefined,
        leadTimeWeeks: e.leadTimeWeeks != null ? String(e.leadTimeWeeks) : undefined,
        expiresAt: e.expiresAt != null ? String(e.expiresAt) : undefined,
      };
    });
  });
  const [dirty, setDirty] = useState(false);
  const upd = (i: number, patch: Partial<RowState>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const accepted = rows.filter((r) => r.accepted).length;
  const flagged = out.matches.filter((m) => m.flags.length).length;
  const canApply = hasPerm(s, 'quotes:write');

  const editsOf = (r: RowState) => {
    const e: Record<string, unknown> = {};
    if (r.unitCost !== undefined) e.unitCost = r.unitCost.trim() === '' ? null : Number(r.unitCost);
    if (r.leadTimeWeeks !== undefined)
      e.leadTimeWeeks = r.leadTimeWeeks.trim() === '' ? null : Number(r.leadTimeWeeks);
    if (r.expiresAt !== undefined) e.expiresAt = r.expiresAt || null;
    return e;
  };
  const reviewBody = () => ({
    review: {
      items: rows.map((r, index) => {
        const e = editsOf(r);
        return { index, accepted: r.accepted, ...(Object.keys(e).length ? { edits: e } : {}) };
      }),
    },
  });
  const save = useMutation({
    mutationFn: () => api.post<Job>('ai', `/jobs/${job.id}/review`, reviewBody()),
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
    mutationFn: async () => {
      setApplyError(null);
      await api.post('ai', `/jobs/${job.id}/review`, reviewBody());
      setDirty(false);
      return api.post<Job>('ai', `/jobs/${job.id}/apply`, {
        matchIndexes: rows.flatMap((r, i) => (r.accepted ? [i] : [])),
      });
    },
    onSuccess: (j) => {
      qc.setQueryData(aiKeys.job(job.id), j);
      qc.invalidateQueries({ queryKey: ['ai', 'jobs'] });
      toast.success(
        `${accepted} ${accepted === 1 ? 'price' : 'prices'} applied to ${out.costRequest.number}`,
      );
    },
    onError: (e) => {
      setApplyError(applyErrorText(e));
      qc.invalidateQueries({ queryKey: aiKeys.job(job.id) });
    },
  });

  const h = out.header;
  // The vendor is known from the pricing request even when the PDF doesn't print a recognisable name.
  const vendor = useQuery({
    queryKey: qk.vendor(out.costRequest.vendorId),
    queryFn: () => api.get<Vendor>('catalog', `/vendors/${out.costRequest.vendorId}`),
    enabled: !h.vendorName,
    meta: { silent: true },
  });
  const vendorName = h.vendorName ?? vendor.data?.name ?? null;
  const applied = job.status === 'applied' ? job.applyResult : null;
  return (
    <div className="space-y-5">
      {applied && (
        <Banner
          tone="ok"
          title={`${applied.applied} prices applied to ${out.costRequest.number}`}
          actions={
            <Link to={`/app/cost-requests/${out.costRequest.id}`}>
              <Button size="sm">Open cost request</Button>
            </Link>
          }
        >
          Recorded as the vendor’s response (source: AI-read PDF) by {job.appliedByName ?? 'someone'}.
        </Banner>
      )}
      <Section title="Quote header" bodyClassName="px-4 py-3">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Vendor', vendorName],
            ['Vendor quote #', h.vendorQuoteNumber],
            ['Quote date', h.quoteDate ? date(h.quoteDate) : null],
            ['Valid until', h.validUntil ? date(h.validUntil) : null],
            ['Lead time', h.leadTime ?? (h.leadTimeWeeks ? `${h.leadTimeWeeks} weeks` : null)],
            ['Freight terms', h.freightTerms],
          ].map(([l, v]) => (
            <div key={l} className="min-w-0">
              <dt className="text-[12px] text-ink-3">{l}</dt>
              <dd className={cx('truncate', !v && 'text-ink-4')} title={v ?? undefined}>
                {v ?? 'Not found'}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line-2 pt-2 text-[13px] text-ink-2">
          <span>
            Answers{' '}
            <Link
              to={`/app/cost-requests/${out.costRequest.id}`}
              className="font-[560] text-lacquer hover:underline"
            >
              {out.costRequest.number}
            </Link>
          </span>
          {out.totals.subtotal != null && <span className="num">Subtotal {money(out.totals.subtotal)}</span>}
          {out.totals.freight != null && <span className="num">Freight {money(out.totals.freight)}</span>}
          {out.totals.total != null && <span className="num">Total {money(out.totals.total)}</span>}
        </div>
      </Section>

      {!readOnly && <Warnings items={out.warnings} />}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Section
          bodyClassName="p-0"
          title={
            <span>
              Matched lines{' '}
              <span className="num font-normal text-ink-3">
                {accepted} of {out.matches.length} selected{flagged ? ` · ${flagged} flagged` : ''}
              </span>
            </span>
          }
        >
          {!out.matches.length ? (
            <p className="px-4 py-6 text-ink-3">
              No quote lines could be matched to the request. Check the unmatched lines below.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-table text-[13px]">
                <thead>
                  <tr>
                    <th style={{ width: 36 }} />
                    <th>Requested</th>
                    <th />
                    <th>Vendor’s line</th>
                    <th className="right">Unit cost</th>
                    <th className="right">Lead time</th>
                    <th>Expires</th>
                    <th>Match</th>
                  </tr>
                </thead>
                <tbody>
                  {out.matches.map((m, i) => {
                    const r = rows[i]!;
                    const change = pctChange(m);
                    const big = change !== null && Math.abs(change) > 40;
                    const qtyOff =
                      m.requestedQuantity != null &&
                      m.extractedLine.quantity != null &&
                      m.requestedQuantity !== m.extractedLine.quantity;
                    return (
                      <tr
                        key={m.costRequestLineId}
                        className={cx(
                          'align-top [&>td]:align-top',
                          m.flags.length > 0 && '[&>td]:bg-warn-50/50',
                          !r.accepted && '[&_td]:text-ink-3',
                        )}
                        onClick={() => m.extractedLine.sourcePage && setPage(m.extractedLine.sourcePage)}
                      >
                        <td>
                          {readOnly ? (
                            <span
                              className={cx(
                                'mt-1.5 block size-2 rounded-full',
                                r.accepted ? 'bg-ok' : 'bg-ink-4',
                              )}
                            />
                          ) : (
                            <Checkbox
                              label={`Apply ${m.code ?? m.name}`}
                              checked={r.accepted}
                              onChange={(accepted) => upd(i, { accepted })}
                            />
                          )}
                        </td>
                        <td className="min-w-[200px]">
                          <div className="num font-[600]">{m.code ?? '—'}</div>
                          <div>{m.name}</div>
                          <div
                            className={cx('num text-[12px]', qtyOff ? 'font-[560] text-risk' : 'text-ink-3')}
                          >
                            Qty {m.requestedQuantity ?? '—'}
                            {m.currentCost != null && ` · now ${money(m.currentCost)}`}
                          </div>
                        </td>
                        <td className="pt-3 text-ink-4">
                          <ArrowRight className="size-4" />
                        </td>
                        <td className="min-w-[220px]">
                          <div className="num text-[12px] text-ink-3">
                            {m.extractedLine.vendorSku ?? 'No SKU'}
                          </div>
                          <div>{m.extractedLine.description}</div>
                          <div
                            className={cx('num text-[12px]', qtyOff ? 'font-[560] text-risk' : 'text-ink-3')}
                          >
                            Qty {m.extractedLine.quantity ?? '—'} · {money(m.extractedLine.unitPrice)}
                          </div>
                        </td>
                        <td className="right min-w-[110px]">
                          {readOnly ? (
                            <span className="num">
                              {money(r.unitCost !== undefined ? Number(r.unitCost) : m.unitCost)}
                            </span>
                          ) : (
                            <CellInput
                              aria-label="Unit cost"
                              inputMode="decimal"
                              className="num text-right"
                              value={r.unitCost ?? m.unitCost?.toFixed(2) ?? ''}
                              changed={r.unitCost !== undefined}
                              onChange={(v) => upd(i, { unitCost: v.replace(/[^0-9.]/g, '') })}
                            />
                          )}
                          {change !== null && (
                            <div
                              className={cx('num text-[12px]', big ? 'font-[600] text-crit' : 'text-ink-3')}
                            >
                              {change > 0 ? '+' : ''}
                              {change.toFixed(0)}% vs current
                            </div>
                          )}
                        </td>
                        <td className="right min-w-[72px]">
                          {readOnly ? (
                            <span className="num">{m.leadTimeWeeks ?? '—'} wk</span>
                          ) : (
                            <CellInput
                              aria-label="Lead time in weeks"
                              inputMode="numeric"
                              className="num text-right"
                              placeholder="wk"
                              value={r.leadTimeWeeks ?? m.leadTimeWeeks?.toString() ?? ''}
                              changed={r.leadTimeWeeks !== undefined}
                              onChange={(v) => upd(i, { leadTimeWeeks: v.replace(/[^0-9]/g, '') })}
                            />
                          )}
                        </td>
                        <td className="min-w-[150px]">
                          {readOnly ? (
                            <span className="num">{date(m.expiresAt)}</span>
                          ) : (
                            <CellInput
                              aria-label="Price expires"
                              type="date"
                              className="num"
                              value={r.expiresAt ?? m.expiresAt ?? ''}
                              changed={r.expiresAt !== undefined}
                              onChange={(v) => upd(i, { expiresAt: v })}
                            />
                          )}
                        </td>
                        <td className="min-w-[200px]">
                          <Confidence value={m.confidence} />
                          <div className="mt-0.5 text-[12px] text-ink-3">{m.reasons.join(' · ')}</div>
                          {m.flags.map((f) => (
                            <div
                              key={f}
                              className="mt-1 flex items-start gap-1 text-[12px] font-[560] text-warn"
                            >
                              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                              {f}
                            </div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <PdfPageViewer
          documentId={documentId}
          page={page}
          pageCount={job.pages}
          onPage={setPage}
          className="h-[60vh] xl:sticky xl:top-4"
        />
      </div>

      {(out.unmatchedLines.length > 0 || out.unquotedRequestLines.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {out.unmatchedLines.length > 0 && (
            <Section title={`Lines on the quote that weren’t requested (${out.unmatchedLines.length})`}>
              <ul className="divide-y divide-line-2 text-[13px]">
                {out.unmatchedLines.map((u) => (
                  <li key={u.lineIndex} className="flex items-start justify-between gap-3 py-2">
                    <div>
                      <div>
                        <span className="num mr-1.5 text-ink-3">{u.line.vendorSku}</span>
                        {u.line.description}
                      </div>
                      <div className="text-[12px] text-ink-3">{u.reason}</div>
                    </div>
                    <span className="num whitespace-nowrap">
                      {u.line.quantity ?? '—'} × {money(u.line.unitPrice)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-ink-3">
                These aren’t applied. Add them to the quote first if they belong.
              </p>
            </Section>
          )}
          {out.unquotedRequestLines.length > 0 && (
            <Section title={`Requested but not priced (${out.unquotedRequestLines.length})`}>
              <ul className="divide-y divide-line-2 text-[13px]">
                {out.unquotedRequestLines.map((u) => (
                  <li key={u.costRequestLineId} className="py-2">
                    <span className="num mr-1.5 font-[600]">{u.code}</span>
                    {u.name}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-ink-3">Follow up with the vendor for these lines.</p>
            </Section>
          )}
        </div>
      )}

      {!readOnly && out.matches.length > 0 && (
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
              Selected prices are recorded as {vendorName ?? 'the vendor'}’s response on{' '}
              {out.costRequest.number}. You approve them into quotes from the cost request.
            </p>
            <Button variant="ghost" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save review
            </Button>
            {canApply ? (
              <Button
                variant="primary"
                disabled={!accepted}
                loading={apply.isPending}
                onClick={() => apply.mutate()}
              >
                Apply {accepted} {accepted === 1 ? 'price' : 'prices'}
              </Button>
            ) : (
              <span className="text-[12px] text-ink-3">Applying prices needs quote edit access</span>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
