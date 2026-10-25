import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { api, errorMessage, type Page } from '@/lib/api';
import { qk } from '../shared';
import type { Line, QuoteDetail, Summary } from '../types';
import { computeQuantity, repriceLine } from './calc';

export type LinePatch = Partial<
  Pick<
    Line,
    | 'locationId'
    | 'qtyMode'
    | 'qtyFixed'
    | 'qtyPerRoom'
    | 'handing'
    | 'atticStockPct'
    | 'unit'
    | 'unitCost'
    | 'costExpiresAt'
    | 'leadTimeWeeks'
    | 'freightUnit'
    | 'markupPct'
    | 'unitPrice'
    | 'name'
    | 'description'
    | 'finish'
    | 'dimensions'
    | 'materials'
    | 'notes'
    | 'clientNotes'
    | 'readyToOrder'
    | 'isSelected'
  >
>;

export const useLines = (quoteId: string) =>
  useQuery({
    queryKey: qk.lines(quoteId),
    queryFn: () => api.get<Page<Line>>('quoting', `/quotes/${quoteId}/lines`, { limit: 2000 }),
    select: (d) => d.items,
  });

export const useSummary = (quoteId: string, enabled: boolean) =>
  useQuery({
    queryKey: qk.summary(quoteId),
    queryFn: () => api.get<Summary>('quoting', `/quotes/${quoteId}/summary`),
    enabled,
  });

/** Refresh everything derived from lines (header totals, summary, matrix) — debounced. */
export function useRefreshDerived(quoteId: string) {
  const qc = useQueryClient();
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (now = false) => {
      if (t.current) clearTimeout(t.current);
      const run = () => {
        qc.invalidateQueries({ queryKey: qk.quote(quoteId), exact: true });
        qc.invalidateQueries({ queryKey: qk.summary(quoteId) });
        qc.invalidateQueries({ queryKey: qk.matrix(quoteId) });
        qc.invalidateQueries({ queryKey: ['quoting', 'quotes'] });
      };
      if (now) run();
      else t.current = setTimeout(run, 450);
    },
    [qc, quoteId],
  );
}

/**
 * Optimistic single-line edits. The cache is updated immediately with a client-side reprice; the
 * server line replaces it when the request settles — unless a newer edit to the same line is in
 * flight, so out-of-order responses never clobber what the user just typed.
 */
export function usePatchLine(quote: QuoteDetail | undefined) {
  const qc = useQueryClient();
  const quoteId = quote?.id ?? '';
  const pending = useRef(new Map<string, number>());
  const refresh = useRefreshDerived(quoteId);
  const key = qk.lines(quoteId);

  const m = useMutation({
    mutationFn: ({ lineId, patch }: { lineId: string; patch: LinePatch; label?: string }) =>
      api.patch<Line>('quoting', `/quotes/${quoteId}/lines/${lineId}`, patch),
    onMutate: async ({ lineId, patch }) => {
      pending.current.set(lineId, (pending.current.get(lineId) ?? 0) + 1);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Page<Line>>(key);
      if (prev && quote)
        qc.setQueryData<Page<Line>>(key, {
          ...prev,
          items: prev.items.map((l) => {
            if (l.id !== lineId) return l;
            const next: Line = { ...l, ...patch } as Line;
            if (patch.unitPrice !== undefined) next.priceOverride = patch.unitPrice !== null;
            if (patch.markupPct !== undefined && patch.unitPrice === undefined) next.priceOverride = false;
            if (patch.qtyPerRoom !== undefined && patch.qtyMode === undefined) next.qtyMode = 'per_room';
            return repriceLine(next, quote);
          }),
        });
      return { prev };
    },
    onError: (e, { lineId }, ctx) => {
      // Roll back only this line, keeping other in-flight optimistic edits.
      const before = ctx?.prev?.items.find((l) => l.id === lineId);
      const cur = qc.getQueryData<Page<Line>>(key);
      if (before && cur)
        qc.setQueryData<Page<Line>>(key, {
          ...cur,
          items: cur.items.map((l) => (l.id === lineId ? before : l)),
        });
      toast.error(errorMessage(e));
    },
    onSuccess: (line, { lineId }) => {
      const n = pending.current.get(lineId) ?? 1;
      if (n > 1) return;
      const cur = qc.getQueryData<Page<Line>>(key);
      if (cur)
        qc.setQueryData<Page<Line>>(key, {
          ...cur,
          items: cur.items.map((l) => (l.id === lineId ? line : l)),
        });
    },
    onSettled: (_d, _e, { lineId }) => {
      const n = (pending.current.get(lineId) ?? 1) - 1;
      if (n <= 0) pending.current.delete(lineId);
      else pending.current.set(lineId, n);
      if (pending.current.size === 0) refresh();
    },
  });
  return m;
}

/** Keep a left/right split consistent with a new quantity (round left, remainder right). */
export const rescaleHanding = (h: Line['handing'], quantity: number) => {
  if (!h) return null;
  const total = h.left + h.right;
  if (total === quantity) return h;
  if (total <= 0) return { left: Math.floor(quantity / 2), right: quantity - Math.floor(quantity / 2) };
  const left = Math.round((quantity * h.left) / total);
  return { left, right: quantity - left };
};

/** Quantity patch that restates handing when the line has a split (the API requires it). */
export function qtyPatch(line: Line, quote: QuoteDetail, patch: LinePatch): LinePatch {
  if (!line.handing || patch.handing !== undefined) return patch;
  const { quantity } = computeQuantity({ ...line, ...patch } as Line, quote.roomTypes);
  return { ...patch, handing: rescaleHanding(line.handing, quantity) };
}

/** Bulk/structural mutation helper: run, toast, refresh lines + derived. */
export function useQuoteAction<TVars, TRes>(
  quoteId: string,
  fn: (v: TVars) => Promise<TRes>,
  opts: {
    success?: (r: TRes, v: TVars) => string | null;
    lines?: boolean;
    onDone?: (r: TRes, v: TVars) => void;
  } = {},
) {
  const qc = useQueryClient();
  const refresh = useRefreshDerived(quoteId);
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      const msg = opts.success?.(r, v);
      if (msg) toast.success(msg);
      if (opts.lines !== false) qc.invalidateQueries({ queryKey: qk.lines(quoteId) });
      refresh(true);
      opts.onDone?.(r, v);
    },
  });
}
