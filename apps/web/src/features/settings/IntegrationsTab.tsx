import { useQuery } from '@tanstack/react-query';
import { Cpu, KeyRound, Landmark } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge, cx, Facts, Spinner, StatusBadge } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago } from '@/lib/format';
import { TabIntro } from './shared';

interface QboStatus {
  configured: boolean;
  connected: boolean;
  status: 'connected' | 'expired' | 'disconnected' | null;
  environment: 'sandbox' | 'production' | 'simulated' | null;
  realmId: string | null;
  connectedByName: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  pending: { invoices: number; bills: number; payments: number; billPayments?: number; errors: number };
}
interface Capabilities {
  provider: string;
  model: string | null;
  mode: 'llm' | 'heuristic';
  label: string;
  ocr: { provider: string; scannedPages: boolean };
  features: { kind: string; name: string; mode: 'llm' | 'heuristic'; applyTarget: string | null }[];
}

function Card({
  icon,
  title,
  status,
  children,
  footer,
}: {
  icon: ReactNode;
  title: string;
  status?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-md border border-line bg-paper">
      <header className="flex items-start gap-3 border-b border-line-2 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-lacquer-50 text-lacquer [&>svg]:size-[18px]">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-[620]">{title}</h3>
          {status && <div className="mt-0.5">{status}</div>}
        </div>
      </header>
      <div className="flex-1 p-4">{children}</div>
      {footer && <footer className="flex flex-wrap gap-2 border-t border-line-2 px-4 py-3">{footer}</footer>}
    </section>
  );
}

export function IntegrationsTab() {
  const s = useSession();
  const canFinance = hasPerm(s, 'finance:read');
  const qbo = useQuery({
    queryKey: ['finance', 'qbo', 'status'],
    queryFn: () => api.get<QboStatus>('finance', '/integrations/qbo'),
    enabled: canFinance,
    meta: { silent: true },
    retry: false,
  });
  const caps = useQuery({
    queryKey: ['ai', 'capabilities'],
    queryFn: () => api.get<Capabilities>('ai', '/capabilities'),
    enabled: hasPerm(s, 'ai:use'),
    meta: { silent: true },
    retry: false,
  });
  const q = qbo.data;
  const pendingTotal = q
    ? q.pending.invoices + q.pending.bills + q.pending.payments + (q.pending.billPayments ?? 0)
    : 0;

  return (
    <>
      <TabIntro title="Integrations">The systems Pro-Cure connects to, and how they’re set up.</TabIntro>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
        <Card
          icon={<Landmark />}
          title="QuickBooks Online"
          status={
            qbo.isLoading ? (
              <Spinner className="size-4" />
            ) : q ? (
              q.connected ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge
                    status={q.status === 'expired' ? 'warn' : 'active'}
                    label={q.status === 'expired' ? 'Reconnect needed' : 'Connected'}
                  />
                  {q.environment === 'simulated' && <Badge>Simulated</Badge>}
                  {q.environment === 'sandbox' && <Badge tone="info">Sandbox</Badge>}
                </span>
              ) : (
                <StatusBadge status="draft" label="Not connected" />
              )
            ) : null
          }
          footer={
            canFinance && (
              <Link
                to="/app/finance?tab=quickbooks"
                className={cx(
                  'inline-flex h-7 items-center rounded-sm px-2.5 text-[13px] font-[560]',
                  q?.connected
                    ? 'border border-line bg-paper text-ink hover:border-ink-4 hover:bg-stone'
                    : 'bg-lacquer text-white hover:bg-lacquer-700',
                )}
              >
                {q?.connected ? 'Manage QuickBooks' : 'Connect QuickBooks'}
              </Link>
            )
          }
        >
          <p className="text-ink-2">
            Invoices, vendor bills and payments sync to your books so accounting doesn’t re-key them.
          </p>
          {!canFinance ? (
            <p className="mt-3 text-[13px] text-ink-3">
              Ask someone in accounting to manage this connection.
            </p>
          ) : qbo.isError ? (
            <p className="mt-3 text-[13px] text-crit">
              Couldn’t load the connection status ({errorMessage(qbo.error)}).
            </p>
          ) : (
            q?.connected && (
              <div className="mt-4">
                <Facts
                  cols={2}
                  items={[
                    { label: 'Company ID', value: <span className="num">{q.realmId}</span> },
                    {
                      label: 'Connected by',
                      value: q.connectedByName ? `${q.connectedByName}, ${ago(q.connectedAt)}` : null,
                    },
                    { label: 'Last sync', value: q.lastSyncAt ? ago(q.lastSyncAt) : 'Not yet' },
                    {
                      label: 'Waiting to sync',
                      value: (
                        <span className={cx('num', q.pending.errors > 0 && 'text-crit')}>
                          {pendingTotal} item{pendingTotal === 1 ? '' : 's'}
                          {q.pending.errors > 0 && ` · ${q.pending.errors} with errors`}
                        </span>
                      ),
                    },
                  ]}
                />
                {q.lastError && (
                  <p className="mt-3 rounded-sm bg-crit-50 px-3 py-2 text-[13px] text-crit">{q.lastError}</p>
                )}
              </div>
            )
          )}
        </Card>

        <Card
          icon={<Cpu />}
          title="AI document reading"
          status={
            caps.data ? (
              caps.data.mode === 'llm' ? (
                <StatusBadge status="active" label={caps.data.label} />
              ) : (
                <StatusBadge status="on_hold" label="Heuristic mode" />
              )
            ) : caps.isLoading ? (
              <Spinner className="size-4" />
            ) : null
          }
        >
          {caps.isError ? (
            <p className="text-[13px] text-crit">Couldn’t load AI settings ({errorMessage(caps.error)}).</p>
          ) : caps.data ? (
            <>
              <p className="text-ink-2">
                {caps.data.mode === 'llm'
                  ? `Brand standards, vendor quotes, drawing packets and inbox email are read by ${caps.data.provider === 'bedrock' ? 'Claude on Amazon Bedrock' : caps.data.provider}. A person reviews every result before it changes anything.`
                  : 'No AI model is configured, so documents and email are read with rule-based parsers. They work well on clean, text-based PDFs; connect Claude on Amazon Bedrock for messy layouts.'}
              </p>
              <div className="mt-4" />
              <Facts
                cols={2}
                items={[
                  { label: 'Model', value: caps.data.model ?? 'None (rules)' },
                  {
                    label: 'Text recognition (OCR)',
                    value:
                      caps.data.ocr.provider === 'textract'
                        ? 'Amazon Textract — scanned pages are read'
                        : 'PDF text layer only — scanned pages are skipped',
                  },
                ]}
              />
              <ul className="mt-4 divide-y divide-line-2 rounded-sm border border-line">
                {caps.data.features.map((f) => (
                  <li
                    key={f.kind}
                    className="flex items-center justify-between gap-3 px-3 py-1.5 text-[13px]"
                  >
                    <span>{f.name}</span>
                    <span className="text-ink-3">{f.mode === 'llm' ? 'AI model' : 'Rules'}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-[13px] text-ink-3">AI features aren’t available to your role.</p>
          )}
        </Card>

        <Card
          icon={<KeyRound />}
          title="Single sign-on"
          status={<StatusBadge status="active" label="Managed per environment" />}
        >
          <p className="text-ink-2">
            Your team can sign in with Microsoft Entra ID (Azure AD) or Google Workspace instead of a Pro-Cure
            password. Sign-in runs through Amazon Cognito, and each environment (staging, production) has its
            own identity-provider connection.
          </p>
          <ul className="mt-3 space-y-1.5 text-[13px] text-ink-2">
            <li>
              <span className="font-[560] text-ink">To turn it on:</span> send your Entra ID tenant ID (or
              Google Workspace domain) to Pro-Cure support; we add it as a federated provider in Cognito for
              your environment.
            </li>
            <li>
              <span className="font-[560] text-ink">Who gets in:</span> only people you’ve invited under
              People. SSO proves who someone is; roles here still decide what they can do.
            </li>
            <li>
              <span className="font-[560] text-ink">Vendors and owners</span> keep signing in with email
              links, so they never need an account in your directory.
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
