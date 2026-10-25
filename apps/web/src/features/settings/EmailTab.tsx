import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, FileText, Inbox, Mail, MessagesSquare, Plus, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CopyField } from '@/components/shared/CopyField';
import { SandboxedHtml } from '@/components/shared/SandboxedHtml';
import {
  Button,
  Chips,
  Dialog,
  EmptyState,
  ErrorNote,
  Facts,
  IconButton,
  Input,
  Loading,
  SearchInput,
  Section,
  Sheet,
  StatusBadge,
  Tabs,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, documentUrl, errorMessage, type Page } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useInboundConfig } from '../comms/shared';
import { settingsKeys, TabIntro } from './shared';

interface Mailbox {
  id: string;
  address: string;
  createdAt: string;
}
type EmailStatus = 'queued' | 'sent' | 'delivered-local' | 'failed';
interface EmailListItem {
  id: string;
  to: string[];
  cc: string[];
  subject: string;
  status: EmailStatus;
  threadId: string | null;
  attachmentCount: number;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}
interface EmailDetail extends EmailListItem {
  fromAddress: string;
  replyTo: string | null;
  textBody: string;
  htmlBody: string | null;
  attachments: { documentId: string; filename: string }[];
  messageId: string;
  providerMessageId: string | null;
  error: string | null;
}

const STATUS: Record<EmailStatus, { status: string; label: string }> = {
  queued: { status: 'queued', label: 'Queued' },
  sent: { status: 'sent', label: 'Sent' },
  'delivered-local': { status: 'delivered', label: 'Delivered (local)' },
  failed: { status: 'failed', label: 'Failed' },
};

export function EmailTab() {
  return (
    <>
      <TabIntro title="Email">
        How vendor email reaches Pro-Cure, and a log of every email Pro-Cure has sent on your behalf.
      </TabIntro>
      <div className="space-y-6">
        <Mailboxes />
        <OutboundLog />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ inbound mailboxes
function Mailboxes() {
  const qc = useQueryClient();
  const cfg = useInboundConfig();
  const [address, setAddress] = useState('');
  const [removing, setRemoving] = useState<Mailbox | null>(null);
  const list = useQuery({
    queryKey: settingsKeys.mailboxes,
    queryFn: () => api.get<Mailbox[]>('comms', '/mailboxes'),
  });
  const add = useMutation({
    mutationFn: () => api.post<Mailbox>('comms', '/mailboxes', { address: address.trim() }),
    onSuccess: (m) => {
      setAddress('');
      qc.invalidateQueries({ queryKey: settingsKeys.mailboxes });
      toast.success(`${m.address} added`);
    },
    onError: () => {},
  });
  const remove = useMutation({
    mutationFn: (m: Mailbox) => api.del('comms', `/mailboxes/${m.id}`),
    onSuccess: (_r, m) => {
      setRemoving(null);
      qc.invalidateQueries({ queryKey: settingsKeys.mailboxes });
      toast.success(`${m.address} removed`);
    },
  });
  const valid = /^[^@\s]*@[^@\s]+\.[^@\s]+$/.test(address.trim());
  const example = list.data?.[0]?.address ?? 'purchasing@yourfirm.com';

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Inbox className="size-4 text-ink-3" /> Receiving vendor email
        </span>
      }
      bodyClassName="p-0"
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="border-line-2 p-4 md:border-r">
          <h3 className="font-[620]">Your mailboxes</h3>
          <p className="mt-0.5 text-[13px] text-ink-2">
            Mail addressed to these addresses is delivered to your firm. Use an exact address, or{' '}
            <span className="num">@yourdomain.com</span> to catch everything at a domain.
          </p>
          {list.isError ? (
            <ErrorNote error={list.error} />
          ) : list.isLoading ? (
            <Loading />
          ) : (
            <ul className="mt-3 divide-y divide-line-2 rounded-sm border border-line">
              {list.data!.map((m) => (
                <li key={m.id} className="flex items-center gap-2.5 px-3 py-2">
                  <Mail className="size-4 shrink-0 text-ink-3" />
                  <span className="num min-w-0 flex-1 truncate font-[560]">{m.address}</span>
                  <span className="hidden text-[12px] text-ink-3 sm:inline">
                    Added {dateTime(m.createdAt).split(' at')[0]}
                  </span>
                  <IconButton label={`Remove ${m.address}`} onClick={() => setRemoving(m)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </li>
              ))}
              {!list.data!.length && (
                <li className="px-3 py-4 text-center text-[13px] text-ink-3">
                  No mailboxes yet. Add the address your vendors already email, such as purchasing@.
                </li>
              )}
            </ul>
          )}
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) add.mutate();
            }}
          >
            <Input
              aria-label="Mailbox address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="purchasing@yourfirm.com"
            />
            <Button
              type="submit"
              icon={<Plus className="size-4" />}
              disabled={!valid}
              loading={add.isPending}
            >
              Add mailbox
            </Button>
          </form>
          {add.isError && <p className="mt-1.5 text-[12.5px] text-crit">{errorMessage(add.error)}</p>}
        </div>

        <div className="border-t border-line-2 bg-stone/60 p-4 md:border-t-0">
          <h3 className="font-[620]">Forward it to Pro-Cure</h3>
          <ol className="mt-2 space-y-3 text-[13px] text-ink-2">
            <li className="flex gap-2.5">
              <Step n={1} />
              <span>
                In Microsoft 365 or Google Workspace, set{' '}
                <span className="num font-[560] text-ink">{example}</span> to forward a copy of every message
                (keep a copy in the mailbox if your team still uses it).
              </span>
            </li>
            <li className="flex gap-2.5">
              <Step n={2} />
              <span className="min-w-0 flex-1">
                Forward to this address:
                {cfg.data ? (
                  <CopyField
                    className="mt-1.5"
                    value={cfg.data.forwardingAddress}
                    label="Forwarding address"
                  />
                ) : (
                  <span className="mt-1.5 block h-9 animate-pulse rounded-sm bg-stone-2" />
                )}
              </span>
            </li>
            <li className="flex gap-2.5">
              <Step n={3} />
              <span>
                Pro-Cure keeps the original To address, so it knows the mail is yours. Replies to emails
                Pro-Cure sends come back on their own thread addresses (
                <span className="num">t-…@{cfg.data?.inboundDomain ?? 'inbound'}</span>) and are filed
                automatically.
              </span>
            </li>
          </ol>
        </div>
      </div>
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Stop receiving ${removing?.address}?`}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              Remove mailbox
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          Mail forwarded from this address will no longer reach your inbox in Pro-Cure. Thread replies are not
          affected.
        </p>
      </Dialog>
    </Section>
  );
}

const Step = ({ n }: { n: number }) => (
  <span className="num grid size-5 shrink-0 place-items-center rounded-full bg-lacquer text-[11px] font-[620] text-white">
    {n}
  </span>
);

// ------------------------------------------------------------------ outbound log
type Filter = 'all' | 'failed';
function OutboundLog() {
  const [filter, setFilter] = useState<Filter>('all');
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const query = { q: q || undefined, status: filter === 'failed' ? 'failed' : undefined, limit: 25, offset };
  const list = useQuery({
    queryKey: settingsKeys.emails(query),
    queryFn: () => api.get<Page<EmailListItem>>('comms', '/emails', query),
    placeholderData: keepPreviousData,
  });

  const columns: Column<EmailListItem>[] = [
    {
      key: 'subject',
      header: 'Email',
      cell: (e) => (
        <div className="min-w-[280px] py-0.5">
          <div className="flex items-center gap-1.5 font-[560]">
            <span className="truncate">{e.subject || '(no subject)'}</span>
            {e.attachmentCount > 0 && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[12px] font-normal text-ink-3">
                <FileText className="size-3" />
                {e.attachmentCount}
              </span>
            )}
          </div>
          <div className="truncate text-[12.5px] text-ink-3">To {e.to.join(', ')}</div>
        </div>
      ),
    },
    {
      key: 'thread',
      header: 'From a thread',
      cell: (e) =>
        e.threadId ? (
          <span className="inline-flex items-center gap-1 text-[13px] text-ink-2">
            <MessagesSquare className="size-3.5" /> Yes
          </span>
        ) : (
          <span className="text-[13px] text-ink-3">System</span>
        ),
    },
    { key: 'status', header: 'Status', cell: (e) => <StatusBadge {...STATUS[e.status]} /> },
    {
      key: 'at',
      header: 'Sent',
      cell: (e) => (
        <span className="num whitespace-nowrap text-[13px] text-ink-2">
          {dateTime(e.sentAt ?? e.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Send className="size-4 text-ink-3" /> Sent email
        </span>
      }
      bodyClassName="p-0"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-line-2 px-3 py-2.5">
        <Chips<Filter>
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setOffset(0);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
        <SearchInput
          value={text}
          onChange={(v) => {
            setText(v);
            setOffset(0);
          }}
          placeholder="Search subject or recipient"
          className="w-full sm:w-[280px]"
        />
        {list.data && <span className="text-[13px] text-ink-3 sm:ml-auto">{list.data.total} emails</span>}
      </div>
      {list.isError ? (
        <ErrorNote error={list.error} />
      ) : (
        <DataTable
          columns={columns}
          rows={list.data?.items}
          loading={list.isLoading}
          onRowClick={(e) => setOpen(e.id)}
          empty={
            <EmptyState
              icon={<Send />}
              title={q || filter === 'failed' ? 'No emails match' : 'Nothing sent yet'}
            >
              {q || filter === 'failed'
                ? 'Try another search or filter.'
                : 'Cost requests, POs, quotes sent to owners and invoices all appear here once they’re emailed.'}
            </EmptyState>
          }
          footer={
            list.data && (
              <Pagination
                total={list.data.total}
                limit={list.data.limit}
                offset={list.data.offset}
                onChange={setOffset}
              />
            )
          }
        />
      )}
      <EmailSheet id={open} onClose={() => setOpen(null)} />
    </Section>
  );
}

function EmailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [view, setView] = useState<'html' | 'text'>('html');
  const email = useQuery({
    queryKey: settingsKeys.email(id ?? ''),
    queryFn: () => api.get<EmailDetail>('comms', `/emails/${id}`),
    enabled: !!id,
  });
  if (!id) return null;
  const e = email.data;
  const showHtml = view === 'html' && !!e?.htmlBody;
  return (
    <Sheet open onClose={onClose} title={e?.subject || 'Email'} width={720}>
      {email.isLoading ? (
        <Loading />
      ) : email.isError || !e ? (
        <ErrorNote error={email.error} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge {...STATUS[e.status]} />
            <span className="text-[13px] text-ink-3">
              {dateTime(e.sentAt ?? e.createdAt)}
              {e.attempts > 1 && ` · ${e.attempts} attempts`}
            </span>
          </div>
          {e.error && (
            <p className="flex items-start gap-2 rounded-sm bg-crit-50 px-3 py-2 text-[13px] text-crit">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {e.error}
            </p>
          )}
          {e.status === 'delivered-local' && (
            <p className="rounded-sm bg-info-50 px-3 py-2 text-[13px] text-info">
              This environment doesn’t send real email: the message was stored here exactly as it would have
              been sent.
            </p>
          )}
          <div className="rounded-sm border border-line">
            <div className="border-b border-line-2 px-4 py-3">
              <Facts
                cols={2}
                items={[
                  { label: 'From', value: e.fromAddress },
                  { label: 'To', value: e.to.join(', ') },
                  ...(e.cc.length ? [{ label: 'Cc', value: e.cc.join(', ') }] : []),
                  ...(e.replyTo
                    ? [{ label: 'Replies go to', value: <span className="num break-all">{e.replyTo}</span> }]
                    : []),
                ]}
              />
            </div>
            {e.htmlBody && (
              <div className="px-4 pt-2">
                <Tabs
                  value={view}
                  onChange={(v) => setView(v as 'html' | 'text')}
                  items={[
                    { value: 'html', label: 'As sent' },
                    { value: 'text', label: 'Plain text' },
                  ]}
                />
              </div>
            )}
            <div className={e.htmlBody ? 'border-t border-line-2 p-4' : 'p-4'}>
              {showHtml ? (
                <SandboxedHtml html={e.htmlBody!} title={`Email: ${e.subject}`} height={520} />
              ) : (
                <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
                  {e.textBody}
                </div>
              )}
            </div>
            {!!e.attachments.length && (
              <div className="border-t border-line-2 px-4 py-3">
                <div className="mb-2 text-[12px] text-ink-3">Attachments</div>
                <ul className="flex flex-wrap gap-2">
                  {e.attachments.map((a) => (
                    <li key={a.documentId}>
                      <a
                        href={documentUrl(a.documentId)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 text-[13px] font-[560] text-lacquer hover:bg-stone"
                      >
                        <FileText className="size-3.5" />
                        {a.filename}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <p className="num break-all text-[11.5px] text-ink-4">Message-ID {e.messageId}</p>
        </div>
      )}
    </Sheet>
  );
}
