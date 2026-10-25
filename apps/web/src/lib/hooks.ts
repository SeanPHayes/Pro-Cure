import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

/**
 * List-page state (filters, search, sort, paging) kept in the URL so views are shareable and survive
 * reloads. `defaults` declares the keys; values are strings ('' = unset).
 */
export function useListParams<T extends Record<string, string>>(defaults: T & { limit?: string }) {
  const [params, setParams] = useSearchParams();
  const values = useMemo(() => {
    const out: Record<string, string> = { ...defaults, offset: '0' };
    for (const k of Object.keys(out)) {
      const v = params.get(k);
      if (v !== null) out[k] = v;
    }
    return out as T & { offset: string };
  }, [params, defaults]);
  const set = useCallback(
    (patch: Partial<Record<keyof T | 'offset', string>>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const resetOffset = !('offset' in patch);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === '' || v === (defaults as Record<string, string>)[k]) next.delete(k);
            else next.set(k, v as string);
          }
          if (resetOffset) next.delete('offset');
          return next;
        },
        { replace: true },
      );
    },
    [setParams, defaults],
  );
  return [values, set] as const;
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Search box state that updates a URL param after typing pauses. */
export function useSearchParamInput(value: string, onCommit: (v: string) => void) {
  const [text, setText] = useState(value);
  const debounced = useDebounced(text);
  useEffect(() => {
    if (debounced !== value) onCommit(debounced);
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setText(value), [value]);
  return [text, setText] as const;
}
