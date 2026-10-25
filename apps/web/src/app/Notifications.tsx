import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { cx } from '@/components/ui';
import { api, getSession } from '@/lib/api';
import { ago } from '@/lib/format';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  severity: 'info' | 'success' | 'warning' | 'critical';
  readAt: string | null;
  createdAt: string;
}

const sev: Record<Notification['severity'], string> = {
  info: 'bg-info',
  success: 'bg-ok',
  warning: 'bg-warn',
  critical: 'bg-crit',
};

/** Bell + popover. Live updates arrive over Server-Sent Events; the query is the source of truth. */
export function Notifications() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      api.get<{ items: Notification[]; unread: number }>('comms', '/notifications', { limit: 30 }),
    refetchInterval: 60_000,
    meta: { silent: true },
  });
  const markAll = useMutation({
    mutationFn: () => api.post('comms', '/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markOne = useMutation({
    mutationFn: (id: string) => api.post('comms', `/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    const token = getSession()?.accessToken;
    if (!token || typeof EventSource === 'undefined') return;
    const es = new EventSource(`/api/comms/notifications/stream?token=${encodeURIComponent(token)}`);
    const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
    es.addEventListener('notification', refresh);
    es.onmessage = refresh;
    es.onerror = () => es.close();
    return () => es.close();
  }, [qc]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);

  const unread = q.data?.unread ?? 0;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        onClick={() => setOpen((o) => !o)}
        className="relative grid size-9 place-items-center rounded-sm text-ink-2 hover:bg-stone-2 hover:text-ink"
      >
        <Bell className="size-[18px]" />
        {unread > 0 && (
          <span className="num absolute top-1 right-1 grid min-w-4 place-items-center rounded-full bg-brass px-1 text-[10px] font-[640] leading-4 text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-[380px] max-w-[calc(100vw-24px)] rounded-md border border-line bg-paper shadow-[var(--shadow-pop)]">
          <div className="flex items-center justify-between border-b border-line-2 px-4 py-2.5">
            <span className="font-[620]">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                className="text-[13px] text-lacquer hover:underline"
                onClick={() => markAll.mutate()}
              >
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-[420px] overflow-y-auto">
            {!q.data?.items.length && (
              <li className="px-4 py-10 text-center text-ink-3">You’re all caught up.</li>
            )}
            {q.data?.items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!n.readAt) markOne.mutate(n.id);
                    setOpen(false);
                    if (n.link) nav(n.link.replace(/^https?:\/\/[^/]+/, ''));
                  }}
                  className={cx(
                    'flex w-full gap-3 px-4 py-3 text-left hover:bg-stone',
                    !n.readAt && 'bg-brass-50/50',
                  )}
                >
                  <span
                    className={cx(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      n.readAt ? 'bg-line' : sev[n.severity],
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block font-[560]">{n.title}</span>
                    <span className="mt-0.5 block text-[13px] text-ink-2">{n.body}</span>
                    <span className="mt-1 block text-[12px] text-ink-3">{ago(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
