import { useMutation, useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, FolderKanban, Package, ReceiptText } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button, cx, EmptyState, Field, Input, SearchInput, Sheet, Spinner } from '@/components/ui';
import { api, errorMessage, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { useDebounced } from '@/lib/hooks';
import type { InboundEmail } from './shared';

type Kind = 'purchase_order' | 'project' | 'quote' | 'cost_request';
interface Target {
  kind: Kind;
  id: string;
  title: string;
  meta: string | null;
  vendorOrgId: string | null;
  clientOrgId: string | null;
}
type Audience = 'internal' | 'vendor' | 'client';
/** The fields used from the projects / quoting / orders list rows. */
interface SearchRow {
  id: string;
  number: string;
  name: string;
  vendorName: string | null;
  projectName: string | null;
  quoteNumber: string | null;
  quoteName: string | null;
  vendorOrgId: string | null;
  clientOrgId: string | null;
}

const KIND_META: Record<Kind, { label: string; icon: ReactNode }> = {
  purchase_order: { label: 'Purchase orders', icon: <Package className="size-4" /> },
  project: { label: 'Projects', icon: <FolderKanban className="size-4" /> },
  quote: { label: 'Quotes', icon: <FileSpreadsheet className="size-4" /> },
  cost_request: { label: 'Cost requests', icon: <ReceiptText className="size-4" /> },
};
const KIND_SINGULAR: Record<Kind, string> = {
  purchase_order: 'purchase order',
  project: 'project',
  quote: 'quote',
  cost_request: 'cost request',
};

/** Pull a likely search term from the subject: a PO / quote / CR number if there is one. */
const guessTerm = (subject: string) =>
  subject.match(/\b(?:PO|Q|CR|P)-\d{2}-\d{3,4}\b/i)?.[0] ??
  subject.match(/\bPO\s*#?\s*(\d{2}-\d{4})\b/i)?.[1] ??
  '';

/**
 * "Route to…": find a purchase order, project, quote or cost request and file the email on its
 * conversation, choosing who can see it (team only, the vendor, or the owner).
 */
export function RouteSheet({
  open,
  onClose,
  email,
  onRouted,
}: {
  open: boolean;
  onClose: () => void;
  email: InboundEmail;
  onRouted: (next: InboundEmail, label: string) => void;
}) {
  const s = useSession();
  const [text, setText] = useState('');
  const term = useDebounced(text.trim(), 250);
  const [picked, setPicked] = useState<Target | null>(null);
  const [audience, setAudience] = useState<Audience>('internal');
  const [subject, setSubject] = useState('');

  useEffect(() => {
    if (open) {
      setText(guessTerm(email.subject));
      setPicked(null);
      setAudience('internal');
      setSubject('');
    }
  }, [open, email.subject]);

  const enabled = open && term.length > 0;
  const orders = useQuery({
    queryKey: ['route-search', 'po', term],
    queryFn: () =>
      api
        .get<Page<SearchRow>>('orders', '/purchase-orders', {
          q: term,
          limit: 6,
          includeClosed: true,
        })
        .then((r) =>
          r.items.map<Target>((x) => ({
            kind: 'purchase_order',
            id: x.id,
            title: `${x.number} · ${x.vendorName}`,
            meta: x.projectName,
            vendorOrgId: x.vendorOrgId,
            clientOrgId: x.clientOrgId,
          })),
        ),
    enabled: enabled && hasPerm(s, 'orders:read'),
    meta: { silent: true },
    retry: false,
  });
  const projects = useQuery({
    queryKey: ['route-search', 'project', term],
    queryFn: () =>
      api.get<Page<SearchRow>>('projects', '/projects', { q: term, limit: 6 }).then((r) =>
        r.items.map<Target>((x) => ({
          kind: 'project',
          id: x.id,
          title: x.name,
          meta: x.number,
          vendorOrgId: null,
          clientOrgId: x.clientOrgId,
        })),
      ),
    enabled,
    meta: { silent: true },
  });
  const quotes = useQuery({
    queryKey: ['route-search', 'quote', term],
    queryFn: () =>
      api.get<Page<SearchRow>>('quoting', '/quotes', { q: term, limit: 6, isTemplate: false }).then((r) =>
        r.items.map<Target>((x) => ({
          kind: 'quote',
          id: x.id,
          title: `${x.number} · ${x.name}`,
          meta: null,
          vendorOrgId: null,
          clientOrgId: x.clientOrgId,
        })),
      ),
    enabled,
    meta: { silent: true },
  });
  const costRequests = useQuery({
    queryKey: ['route-search', 'cr', term],
    queryFn: () =>
      api.get<Page<SearchRow>>('quoting', '/cost-requests', { q: term, limit: 6 }).then((r) =>
        r.items.map<Target>((x) => ({
          kind: 'cost_request',
          id: x.id,
          title: `${x.number} · ${x.vendorName ?? 'Vendor'}`,
          meta: x.quoteName ? `${x.quoteNumber} ${x.quoteName}` : null,
          vendorOrgId: x.vendorOrgId,
          clientOrgId: null,
        })),
      ),
    enabled: enabled && hasPerm(s, 'quotes:costs:read'),
    meta: { silent: true },
  });

  const groups: { kind: Kind; q: typeof orders }[] = [
    { kind: 'purchase_order', q: orders },
    { kind: 'project', q: projects },
    { kind: 'quote', q: quotes },
    { kind: 'cost_request', q: costRequests },
  ];
  const loading = groups.some((g) => g.q.isFetching);
  const total = groups.reduce((n, g) => n + (g.q.data?.length ?? 0), 0);

  const route = useMutation({
    mutationFn: () =>
      api.post<InboundEmail>('comms', `/inbound/${email.id}/route`, {
        entityType: picked!.kind,
        entityId: picked!.id,
        visibility: audience,
        ...(audience === 'vendor' && picked!.vendorOrgId ? { vendorOrgId: picked!.vendorOrgId } : {}),
        ...(audience === 'client' && picked!.clientOrgId ? { clientOrgId: picked!.clientOrgId } : {}),
        ...(subject.trim() ? { subject: subject.trim() } : {}),
      }),
    onSuccess: (next) => onRouted(next, picked!.title),
  });

  const audiences: { value: Audience; label: string; hint: string; disabled?: string }[] = [
    { value: 'internal', label: 'Team only', hint: 'Only your firm sees this email on the record.' },
    {
      value: 'vendor',
      label: 'Vendor thread',
      hint: 'Shared with the vendor on their portal; replies from the team reach them.',
      disabled:
        picked && !picked.vendorOrgId ? 'This record has no connected vendor organization.' : undefined,
    },
    {
      value: 'client',
      label: 'Owner thread',
      hint: 'Shared with the hotel owner on their portal. Check it contains no cost or vendor pricing.',
      disabled:
        picked && !picked.clientOrgId ? 'This record has no connected owner organization.' : undefined,
    },
  ];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Route email"
      description="File this email on the conversation of a purchase order, project, quote or cost request."
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!picked}
            loading={route.isPending}
            onClick={() => route.mutate()}
          >
            {picked ? `Route to ${KIND_SINGULAR[picked.kind]}` : 'Route email'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <SearchInput
          value={text}
          onChange={(v) => {
            setText(v);
            setPicked(null);
          }}
          placeholder="Search PO number, project, quote or vendor"
        />

        <div className="min-h-[180px]">
          {!term ? (
            <p className="py-6 text-center text-ink-3">
              Type a PO number, project or property name, quote number, or vendor.
            </p>
          ) : loading && !total ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : !total ? (
            <EmptyState title="No matching records">
              Try fewer words, or the number printed on the vendor’s document.
            </EmptyState>
          ) : (
            <div className="space-y-4" role="radiogroup" aria-label="Route target">
              {groups.map(({ kind, q }) =>
                q.data?.length ? (
                  <div key={kind}>
                    <div className="mb-1 flex items-center gap-1.5 text-[12px] text-ink-3">
                      {KIND_META[kind].icon}
                      {KIND_META[kind].label}
                    </div>
                    <ul className="divide-y divide-line-2 rounded-sm border border-line">
                      {q.data.map((t) => {
                        const on = picked?.id === t.id;
                        return (
                          <li key={t.id}>
                            {/* biome-ignore lint/a11y/useSemanticElements: a rich, full-row radio option */}
                            <button
                              type="button"
                              role="radio"
                              aria-checked={on}
                              onClick={() => {
                                setPicked(t);
                                if (audience === 'vendor' && !t.vendorOrgId) setAudience('internal');
                                if (audience === 'client' && !t.clientOrgId) setAudience('internal');
                              }}
                              className={cx(
                                'flex w-full items-center gap-3 px-3 py-2 text-left',
                                on ? 'bg-brass-50' : 'hover:bg-stone',
                              )}
                            >
                              <span
                                className={cx(
                                  'grid size-4 shrink-0 place-items-center rounded-full border',
                                  on ? 'border-brass' : 'border-ink-4',
                                )}
                              >
                                {on && <span className="size-2 rounded-full bg-brass" />}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-[560]">{t.title}</span>
                                {t.meta && (
                                  <span className="block truncate text-[12px] text-ink-3">{t.meta}</span>
                                )}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null,
              )}
              {orders.isError && (
                <p className="text-[12px] text-ink-3">
                  Purchase orders couldn’t be searched right now ({errorMessage(orders.error)}). Projects,
                  quotes and cost requests are still listed.
                </p>
              )}
            </div>
          )}
        </div>

        {picked && (
          <>
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-[560] text-ink-2">Who can see it</legend>
              <div className="space-y-1.5">
                {audiences.map((a) => (
                  <label
                    key={a.value}
                    className={cx(
                      'flex cursor-pointer items-start gap-2.5 rounded-sm border px-3 py-2',
                      audience === a.value ? 'border-brass bg-brass-50' : 'border-line hover:bg-stone',
                      a.disabled && 'cursor-not-allowed opacity-55 hover:bg-transparent',
                    )}
                  >
                    <input
                      type="radio"
                      name="audience"
                      className="mt-1 accent-lacquer"
                      checked={audience === a.value}
                      disabled={!!a.disabled}
                      onChange={() => setAudience(a.value)}
                    />
                    <span>
                      <span className="block font-[560]">{a.label}</span>
                      <span className="block text-[12.5px] text-ink-3">{a.disabled ?? a.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Thread subject" hint="Only used if the record has no thread for this audience yet.">
              {(id) => (
                <Input
                  id={id}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={email.subject}
                />
              )}
            </Field>
          </>
        )}
        {route.isError && (
          <p className="rounded-sm bg-crit-50 px-3 py-2 text-[13px] text-crit">{errorMessage(route.error)}</p>
        )}
      </div>
    </Sheet>
  );
}
