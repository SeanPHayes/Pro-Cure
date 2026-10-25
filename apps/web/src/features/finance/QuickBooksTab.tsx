import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Link2, PlugZap, RefreshCw, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Chips,
  cx,
  Dialog,
  EmptyState,
  ErrorNote,
  Facts,
  Field,
  Input,
  Loading,
  Section,
  StatusBadge,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, dateTime, humanize } from '@/lib/format';
import { useListParams } from '@/lib/hooks';
import { fk, useInvalidateFinance } from './shared';
import {
  type QboSettings,
  type QboStatus,
  SYNC_ENTITIES,
  type SyncEntity,
  type SyncLogEntry,
  type SyncResult,
} from './types';

const plural = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : null);

const ENV_LABEL = { simulated: 'Simulated', sandbox: 'Sandbox', production: 'Production' } as const;
const ENTITY_LABEL: Record<SyncEntity, string> = {
  customers: 'Customers (owners)',
  vendors: 'Vendors',
  invoices: 'Invoices',
  bills: 'Vendor bills',
  payments: 'Payments (both directions)',
};
const LOG_DEFAULTS = { tab: 'quickbooks', logStatus: '', limit: '25' };

export function QuickBooksTab() {
  const s = useSession();
  const canManage = hasPerm(s, 'integrations:write');
  const invalidate = useInvalidateFinance();
  const status = useQuery({
    queryKey: fk.qbo,
    queryFn: () => api.get<QboStatus>('finance', '/integrations/qbo'),
  });
  const [disconnecting, setDisconnecting] = useState(false);
  const [entities, setEntities] = useState<Set<SyncEntity>>(new Set(SYNC_ENTITIES));
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const connect = useMutation({
    mutationFn: () => api.post<{ authorizeUrl: string }>('finance', '/integrations/qbo/connect'),
    onSuccess: (r) => {
      window.location.assign(r.authorizeUrl);
    },
  });
  const simulate = useMutation({
    mutationFn: () => api.post<QboStatus>('finance', '/integrations/qbo/simulate'),
    onSuccess: () => {
      toast.success('Simulated QuickBooks connected');
      invalidate();
    },
  });
  const sync = useMutation({
    mutationFn: () =>
      api.post<SyncResult>('finance', '/integrations/qbo/sync', {
        entities: entities.size === SYNC_ENTITIES.length ? undefined : [...entities],
      }),
    onSuccess: (r) => {
      setLastResult(r);
      const errors = Object.values(r).reduce((n, v) => n + (typeof v === 'object' ? v.error : 0), 0);
      const ok = Object.values(r).reduce((n, v) => n + (typeof v === 'object' ? v.success : 0), 0);
      if (errors)
        toast.error(`Sync finished with ${errors} ${errors === 1 ? 'error' : 'errors'}; see the log`);
      else
        toast.success(
          ok
            ? `QuickBooks synced: ${ok} ${ok === 1 ? 'record' : 'records'}`
            : 'QuickBooks is already up to date',
        );
      invalidate();
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.post<QboStatus>('finance', '/integrations/qbo/disconnect'),
    onSuccess: () => {
      toast.success('QuickBooks disconnected');
      setDisconnecting(false);
      invalidate();
    },
  });

  if (status.isLoading) return <Loading label="Checking QuickBooks" />;
  if (status.isError) return <ErrorNote error={status.error} />;
  const q = status.data!;
  const pendingTotal = q.pending.invoices + q.pending.bills + q.pending.payments + q.pending.billPayments;

  return (
    <div className="mx-auto max-w-[1360px] space-y-4 px-4 py-5 sm:px-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Section
          title="Connection"
          actions={
            q.connected ? (
              <Badge tone="ok">
                <CheckCircle2 className="size-3.5" />
                Connected
              </Badge>
            ) : q.status === 'expired' ? (
              <Badge tone="warn">Authorization expired</Badge>
            ) : (
              <Badge>Not connected</Badge>
            )
          }
        >
          {q.connected || q.status === 'expired' ? (
            <>
              <Facts
                cols={2}
                items={[
                  {
                    label: 'Company',
                    value: (
                      <span className="inline-flex items-center gap-2">
                        <span className="num">{q.realmId}</span>
                        {q.environment && (
                          <Badge tone={q.environment === 'production' ? 'lacquer' : 'brass'}>
                            {ENV_LABEL[q.environment]}
                          </Badge>
                        )}
                      </span>
                    ),
                  },
                  {
                    label: 'Last sync',
                    value: q.lastSyncAt ? (
                      <span title={dateTime(q.lastSyncAt)}>{ago(q.lastSyncAt)}</span>
                    ) : (
                      'Never'
                    ),
                  },
                  {
                    label: 'Connected by',
                    value: q.connectedByName ? `${q.connectedByName}, ${ago(q.connectedAt)}` : '—',
                  },
                  {
                    label: 'Waiting to sync',
                    value: pendingTotal ? (
                      <span className="num">
                        {[
                          plural(q.pending.invoices, 'invoice'),
                          plural(q.pending.bills, 'bill'),
                          plural(q.pending.payments + q.pending.billPayments, 'payment'),
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    ) : (
                      'Nothing — up to date'
                    ),
                  },
                ]}
              />
              {q.environment === 'simulated' && (
                <p className="mt-4 rounded-sm bg-brass-50 px-3 py-2 text-[13px] text-ink-2">
                  This is a simulated company for demos and training. Syncs run end to end and write the log,
                  but nothing reaches a real QuickBooks file.
                </p>
              )}
              {(q.lastError || q.pending.errors > 0) && (
                <p className="mt-3 flex items-start gap-2 rounded-sm bg-crit-50 px-3 py-2 text-[13px] text-crit">
                  <CircleAlert className="mt-px size-4 shrink-0" />
                  <span>
                    {q.pending.errors > 0 && `${q.pending.errors} records failed to sync. `}
                    {q.lastError}
                  </span>
                </p>
              )}
              {canManage && (
                <div className="mt-4 flex flex-wrap gap-2 border-t border-line-2 pt-4">
                  {q.status === 'expired' && q.configured && (
                    <Button
                      variant="primary"
                      icon={<Link2 className="size-4" />}
                      loading={connect.isPending}
                      onClick={() => connect.mutate()}
                    >
                      Reconnect QuickBooks
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    icon={<Unplug className="size-4" />}
                    onClick={() => setDisconnecting(true)}
                  >
                    Disconnect
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="py-2">
              <p className="max-w-[60ch] text-ink-2">
                Connect QuickBooks Online to push owner invoices, vendor bills and payments as they happen,
                and pull payments your team records in QuickBooks back into Pro-Cure.
              </p>
              {canManage ? (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {q.configured ? (
                    <Button
                      variant="primary"
                      icon={<Link2 className="size-4" />}
                      loading={connect.isPending}
                      onClick={() => connect.mutate()}
                    >
                      Connect QuickBooks
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="primary"
                        icon={<PlugZap className="size-4" />}
                        loading={simulate.isPending}
                        onClick={() => simulate.mutate()}
                      >
                        Use simulated connection
                      </Button>
                      <span className="text-[13px] text-ink-3">
                        Intuit credentials aren’t configured on this server, so only a simulated company is
                        available.
                      </span>
                    </>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-ink-3">
                  Ask an administrator or your controller to connect it.
                </p>
              )}
            </div>
          )}
        </Section>

        <Section title="Sync now">
          {!q.connected ? (
            <p className="text-ink-3">Connect QuickBooks to sync.</p>
          ) : !canManage ? (
            <p className="text-ink-2">
              Invoices, vendor bills and payments sync automatically every 15 minutes. Your controller or an
              administrator can run a sync on demand.
            </p>
          ) : (
            <>
              <fieldset disabled={!canManage}>
                <legend className="sr-only">Records to sync</legend>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {SYNC_ENTITIES.map((e) => (
                    <li key={e}>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer rounded-xs accent-lacquer"
                          checked={entities.has(e)}
                          onChange={(ev) => {
                            const v = ev.target.checked;
                            setEntities((cur) => {
                              const next = new Set(cur);
                              if (v) next.add(e);
                              else next.delete(e);
                              return next;
                            });
                          }}
                        />
                        {ENTITY_LABEL[e]}
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              {canManage && (
                <div className="mt-4 flex items-center gap-3">
                  <Button
                    variant="primary"
                    icon={<RefreshCw className="size-4" />}
                    loading={sync.isPending}
                    disabled={!entities.size}
                    onClick={() => sync.mutate()}
                  >
                    Sync now
                  </Button>
                  <span className="text-[13px] text-ink-3">Also runs automatically every 15 minutes.</span>
                </div>
              )}
              {lastResult && <ResultSummary r={lastResult} />}
            </>
          )}
        </Section>
      </div>

      {(q.connected || q.status === 'expired') && (
        <SettingsSection settings={q.settings} canManage={canManage} />
      )}

      <SyncLog />

      <Dialog
        open={disconnecting}
        onClose={() => setDisconnecting(false)}
        title="Disconnect QuickBooks?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisconnecting(false)}>
              Keep connected
            </Button>
            <Button variant="danger" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Disconnect
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          Pro-Cure stops pushing invoices, bills and payments to company{' '}
          <span className="num font-[560] text-ink">{q.realmId}</span>. Records already in QuickBooks stay
          there, and reconnecting the same company later picks up where it left off.
        </p>
      </Dialog>
    </div>
  );
}

function ResultSummary({ r }: { r: SyncResult }) {
  const rows: [string, { success: number; error: number }][] = [
    ['Customers', r.customers],
    ['Vendors', r.vendors],
    ['Invoices', r.invoices],
    ['Bills', r.bills],
    ['Payments', r.payments],
    ['Bill payments', r.billPayments],
    ['Pulled payments', r.pulledPayments],
  ];
  const shown = rows.filter(([, c]) => c.success || c.error);
  return (
    <div className="mt-4 border-t border-line-2 pt-3 text-[13px]">
      <div className="text-ink-3">Last run, {ago(r.finishedAt)}</div>
      {shown.length ? (
        <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          {shown.map(([l, c]) => (
            <li key={l} className="num">
              {l} <span className="font-[560] text-ok">{c.success}</span>
              {c.error > 0 && <span className="ml-1 font-[560] text-crit">· {c.error} failed</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-ink-2">Nothing needed syncing.</p>
      )}
    </div>
  );
}

const SETTING_FIELDS: { key: keyof QboSettings; label: string; hint: string }[] = [
  { key: 'incomeAccountId', label: 'Income account', hint: 'Revenue account for invoice lines.' },
  { key: 'expenseAccountId', label: 'Expense account', hint: 'Cost of goods account for vendor bills.' },
  {
    key: 'depositAccountId',
    label: 'Deposit account',
    hint: 'Where received payments land (e.g. Undeposited Funds).',
  },
  { key: 'bankAccountId', label: 'Bank account', hint: 'Account vendor payments are drawn from.' },
  { key: 'itemId', label: 'Product/service item', hint: 'Item used on invoice lines.' },
];

function SettingsSection({ settings, canManage }: { settings: QboSettings; canManage: boolean }) {
  const invalidate = useInvalidateFinance();
  const [draft, setDraft] = useState<QboSettings>(settings);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const save = useMutation({
    mutationFn: () =>
      api.patch<QboStatus>('finance', '/integrations/qbo/settings', {
        ...Object.fromEntries(
          SETTING_FIELDS.map((f) => [
            f.key,
            (draft[f.key] as string | null | undefined)?.toString().trim() || null,
          ]),
        ),
        syncPayments: draft.syncPayments,
      }),
    onSuccess: () => {
      toast.success('QuickBooks settings saved');
      invalidate();
    },
  });
  return (
    <Section
      title="Account mapping"
      actions={
        canManage && (
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save settings
          </Button>
        )
      }
    >
      <p className="mb-4 max-w-[75ch] text-[13px] text-ink-2">
        QuickBooks account and item ids to post to. Leave a field blank to use the company’s default account.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SETTING_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            {(id) => (
              <Input
                id={id}
                className="num"
                disabled={!canManage}
                value={(draft[f.key] as string | null | undefined) ?? ''}
                placeholder="Default"
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            )}
          </Field>
        ))}
        <div className="flex flex-col justify-center">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="size-4 cursor-pointer rounded-xs accent-lacquer"
              checked={draft.syncPayments}
              onChange={(ev) => {
                const v = ev.target.checked;
                setDraft((d) => ({ ...d, syncPayments: v }));
              }}
            />
            <span className="font-[560]">Sync payments</span>
          </label>
          <p className="mt-1 pl-6 text-[12px] text-ink-3">
            Push payments recorded here and pull ones entered in QuickBooks.
          </p>
        </div>
      </div>
    </Section>
  );
}

function SyncLog() {
  const [p, set] = useListParams(LOG_DEFAULTS);
  const query = { status: p.logStatus || undefined, limit: Number(p.limit), offset: Number(p.offset) };
  const log = useQuery({
    queryKey: fk.qboLog(query),
    queryFn: () => api.get<Page<SyncLogEntry>>('finance', '/integrations/qbo/log', query),
    placeholderData: keepPreviousData,
  });
  const columns: Column<SyncLogEntry>[] = [
    {
      key: 'when',
      header: 'When',
      cell: (r) => (
        <span className="num whitespace-nowrap text-ink-2" title={dateTime(r.createdAt)}>
          {dateTime(r.createdAt)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Result',
      cell: (r) => (
        <StatusBadge
          status={r.status === 'success' ? 'synced' : 'error'}
          label={r.status === 'success' ? 'Success' : 'Error'}
        />
      ),
    },
    {
      key: 'entity',
      header: 'Record',
      cell: (r) => <span className="whitespace-nowrap">{humanize(r.entityType)}</span>,
    },
    {
      key: 'dir',
      header: 'Direction',
      cell: (r) => (
        <span className="whitespace-nowrap text-ink-2">
          {r.direction === 'push' ? 'To QuickBooks' : 'From QuickBooks'}
        </span>
      ),
    },
    {
      key: 'message',
      header: 'Details',
      cell: (r) => (
        <span className={cx('block min-w-[240px]', r.status === 'error' ? 'text-crit' : 'text-ink')}>
          {r.message ?? '—'}
        </span>
      ),
    },
    {
      key: 'qbo',
      header: 'QuickBooks id',
      cell: (r) => <span className="num whitespace-nowrap text-[12px] text-ink-3">{r.qboId ?? '—'}</span>,
    },
  ];
  return (
    <Section
      title="Sync log"
      bodyClassName=""
      className="overflow-hidden"
      actions={
        <Chips
          value={p.logStatus}
          onChange={(v) => set({ logStatus: v })}
          options={[
            { value: '', label: 'All' },
            { value: 'success', label: 'Success' },
            { value: 'error', label: 'Errors' },
          ]}
        />
      }
    >
      {log.isError ? (
        <ErrorNote error={log.error} />
      ) : (
        <div className="[&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
          <DataTable
            dense
            columns={columns}
            rows={log.data?.items}
            loading={log.isLoading}
            empty={
              <EmptyState title={p.logStatus === 'error' ? 'No sync errors' : 'No syncs yet'}>
                {p.logStatus === 'error'
                  ? 'Every record pushed to QuickBooks went through.'
                  : 'Each record pushed to or pulled from QuickBooks is logged here.'}
              </EmptyState>
            }
            footer={
              log.data && (
                <Pagination
                  total={log.data.total}
                  limit={log.data.limit}
                  offset={log.data.offset}
                  onChange={(o) => set({ offset: String(o) })}
                />
              )
            }
          />
        </div>
      )}
    </Section>
  );
}
