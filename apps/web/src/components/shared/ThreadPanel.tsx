import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MessagesSquare, Paperclip, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Avatar, Button, cx, EmptyState, Input, Spinner, Textarea } from '@/components/ui';
import { api, documentUrl } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { uploadDocument } from './DocumentsPanel';

interface Message {
  id: string;
  authorName: string;
  authorEmail: string | null;
  authorActor: string;
  authorUserId: string | null;
  direction: 'internal' | 'outbound' | 'inbound';
  channel: 'app' | 'email';
  bodyText: string;
  attachmentDocumentIds: string[];
  attachments?: { documentId: string; filename: string }[];
  createdAt: string;
}
interface Thread {
  id: string;
  subject: string;
  visibility: 'internal' | 'vendor' | 'client';
  emailAlias?: string;
  replyTo?: string;
  messages: Message[] | { items: Message[] };
}

const who: Record<string, string> = { vendor: 'Vendor', client: 'Owner', email: 'Email', system: 'Pro-Cure' };

/**
 * Conversation attached to a record (PO, project, quote, claim, cost request). Internal users can
 * pick the audience (team only, vendor, owner) and optionally send the message by email; replies to
 * those emails land back here.
 */
export function ThreadPanel({
  entityType,
  entityId,
  visibility = 'internal',
  vendorOrgId,
  clientOrgId,
  allowEmail,
  emptyHint,
}: {
  entityType: string;
  entityId: string;
  visibility?: 'internal' | 'vendor' | 'client';
  vendorOrgId?: string | null;
  clientOrgId?: string | null;
  allowEmail?: boolean;
  emptyHint?: string;
}) {
  const s = useSession();
  const qc = useQueryClient();
  const key = ['thread', entityType, entityId, visibility];
  const thread = useQuery({
    queryKey: key,
    queryFn: () =>
      api
        .get<Thread>('comms', '/threads/for', { entityType, entityId, visibility, vendorOrgId, clientOrgId })
        .then((t) => api.get<Thread>('comms', `/threads/${t.id}`)),
    refetchInterval: 20_000,
  });
  const [body, setBody] = useState('');
  const [emailTo, setEmailTo] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const messages = thread.data
    ? Array.isArray(thread.data.messages)
      ? thread.data.messages
      : thread.data.messages.items
    : [];

  useEffect(() => {
    // Scroll the message list itself (not the page) to the newest message.
    const list = bottom.current?.parentElement;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  const post = useMutation({
    mutationFn: async () => {
      const ids: string[] = [];
      for (const f of files) {
        const d = await uploadDocument(f, {
          entityType,
          entityId,
          kind: 'other',
          visibility,
          vendorOrgId,
          clientOrgId,
        });
        ids.push(d.id);
      }
      return api.post('comms', `/threads/${thread.data!.id}/messages`, {
        bodyText: body.trim(),
        attachmentDocumentIds: ids,
        emailTo: emailTo
          .split(/[,\s;]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      });
    },
    onSuccess: () => {
      setBody('');
      setFiles([]);
      setEmailTo('');
      qc.invalidateQueries({ queryKey: key });
    },
  });

  if (thread.isLoading)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  if (!thread.data) return null;

  return (
    <div className="flex flex-col">
      <div className="max-h-[520px] space-y-4 overflow-y-auto pr-1">
        {!messages.length && (
          <EmptyState icon={<MessagesSquare />} title="No messages yet">
            {emptyHint ?? 'Start the conversation. Everyone who can see this record can follow it here.'}
          </EmptyState>
        )}
        {messages.map((m) => {
          const mine = m.authorUserId === s?.user.id;
          return (
            <div key={m.id} className={cx('flex gap-3', mine && 'flex-row-reverse')}>
              <Avatar
                name={m.authorName}
                tone={m.authorActor === 'internal' ? 'lacquer' : 'brass'}
                size={30}
              />
              <div className={cx('max-w-[78%] min-w-0', mine && 'text-right')}>
                <div className="text-[12px] text-ink-3">
                  <span className="font-[560] text-ink-2">{m.authorName}</span>
                  {who[m.authorActor] && ` · ${who[m.authorActor]}`}
                  {m.channel === 'email' && (
                    <Mail
                      className="mx-1 inline size-3 align-[-1px]"
                      aria-label={m.direction === 'inbound' ? 'Received by email' : 'Sent by email'}
                    />
                  )}{' '}
                  · {dateTime(m.createdAt)}
                </div>
                <div
                  className={cx(
                    'mt-1 inline-block rounded-md px-3 py-2 text-left whitespace-pre-wrap',
                    mine ? 'bg-lacquer-50' : 'border border-line bg-paper',
                  )}
                >
                  {m.bodyText}
                  {(
                    m.attachments ??
                    m.attachmentDocumentIds.map((id) => ({ documentId: id, filename: 'Attachment' }))
                  ).map((a) => (
                    <a
                      key={a.documentId}
                      href={documentUrl(a.documentId)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 flex items-center gap-1.5 text-[13px] text-lacquer hover:underline"
                    >
                      <Paperclip className="size-3.5" />
                      {a.filename}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      <form
        className="mt-4 space-y-2 border-t border-line-2 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) post.mutate();
        }}
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            s && s.context.actor !== 'internal'
              ? 'Write a message…'
              : visibility === 'vendor'
                ? 'Message the vendor…'
                : visibility === 'client'
                  ? 'Message the owner…'
                  : 'Message the team…'
          }
          rows={3}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) post.mutate();
          }}
        />
        {allowEmail && (
          <Input
            value={emailTo}
            onChange={(e) => setEmailTo(e.target.value)}
            placeholder="Also email to (optional) — replies come back to this thread"
          />
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={<Paperclip className="size-4" />}
              onClick={() => fileInput.current?.click()}
            >
              Attach
            </Button>
            <span className="truncate text-[12px] text-ink-3">{files.map((f) => f.name).join(', ')}</span>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => setFiles([...(e.target.files ?? [])])}
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<Send className="size-3.5" />}
            loading={post.isPending}
            disabled={!body.trim()}
          >
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
