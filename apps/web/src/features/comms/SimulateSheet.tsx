import { useMutation, useQuery } from '@tanstack/react-query';
import { Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Field, IconButton, Input, Select, Sheet, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { fileSize, type InboundStatus, useInboundConfig } from './shared';

interface Preset {
  label: string;
  from: string;
  fromName: string;
  subject: string;
  text: string;
}

const PRESETS: Preset[] = [
  {
    label: 'Shipping notice with UPS tracking',
    from: 'will.harmon@carolinacasegoods.example',
    fromName: 'Will Harmon',
    subject: 'RE: PO-26-0008 acknowledgement',
    text: 'Hi,\n\nThe casegoods for PO-26-0008 shipped today via UPS.\nTracking number: 1Z999AA10123456784\n\nThanks,\nWill Harmon\nCarolina Casegoods Co.',
  },
  {
    label: 'Pro-forma deposit invoice',
    from: 'ar@northlineseating.example',
    fromName: 'Priya Raman',
    subject: 'Pro-forma invoice - 50% deposit required - PO 26-0009',
    text: 'Hello,\n\nAttached is pro-forma invoice PF-20931 for PO 26-0009. A 50% deposit of $18,450.00 is required before we release the order to production.\n\nPriya Raman\nNorthline Seating',
  },
  {
    label: 'Ship-date change, no PO number',
    from: 'dale@lumenforge.example',
    fromName: 'Dale Ostrowski',
    subject: 'Updated ship schedule',
    text: 'Our glass supplier is running behind. New ship date is November 18, 2026 for everything on your open orders with us.\n\nDale\nLumen & Forge Lighting',
  },
];

const readBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/**
 * Demo / local only: deliver an email to this tenant through the real inbound pipeline (parsing,
 * attachment storage, alias matching, AI routing) without a mail server.
 */
export function SimulateSheet({
  open,
  onClose,
  onSent,
  defaultTo,
}: {
  open: boolean;
  onClose: () => void;
  onSent: (id: string) => void;
  defaultTo?: string;
}) {
  const cfg = useInboundConfig();
  const session = useSession();
  // Default recipient: the tenant's first mailbox (needs org:admin to list), else the forwarding address.
  const mailboxes = useQuery({
    queryKey: ['inbox', 'mailboxes'],
    queryFn: () => api.get<{ address: string }[]>('comms', '/mailboxes'),
    enabled: open && hasPerm(session, 'org:admin'),
    meta: { silent: true },
    retry: false,
  });
  const to =
    defaultTo ??
    mailboxes.data?.find((m) => !m.address.startsWith('@'))?.address ??
    cfg.data?.forwardingAddress ??
    '';
  const [form, setForm] = useState({ from: '', fromName: '', to, subject: '', text: '' });
  const [files, setFiles] = useState<File[]>([]);
  const input = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the sheet opens
  useEffect(() => {
    if (open) {
      setForm({ from: '', fromName: '', to, subject: '', text: '' });
      setFiles([]);
    }
  }, [open]);
  // The mailbox list can arrive after opening: fill the recipient if the user hasn't typed one.
  useEffect(() => {
    if (open && to) setForm((f) => (f.to ? f : { ...f, to }));
  }, [open, to]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const send = useMutation({
    mutationFn: async () =>
      api.post<{ id: string; status: InboundStatus; duplicate: boolean }>('comms', '/inbound/simulate', {
        from: form.from.trim(),
        fromName: form.fromName.trim() || undefined,
        to: form.to
          .split(/[,;\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        subject: form.subject,
        text: form.text,
        attachments: await Promise.all(
          files.map(async (f) => ({
            filename: f.name,
            contentType: f.type || 'application/octet-stream',
            base64: await readBase64(f),
          })),
        ),
      }),
    onSuccess: (r) => {
      toast.success(r.status === 'routed' ? 'Email delivered and filed' : 'Email delivered');
      onSent(r.id);
    },
    onError: () => {},
  });

  const valid = /.+@.+\..+/.test(form.from) && form.to.trim() && (form.subject.trim() || form.text.trim());

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Simulate an email"
      description="Demo and test environments only. The email goes through the same pipeline as real mail: attachments are stored, reply addresses are matched, and the AI agent reads it."
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={send.isPending} onClick={() => send.mutate()}>
            Deliver email
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) send.mutate();
        }}
      >
        <Field
          label="Start from an example"
          hint="Fills in the fields below; edit anything before delivering."
        >
          {(id) => (
            <Select
              id={id}
              placeholder="Choose an example…"
              value=""
              options={PRESETS.map((p, i) => ({ value: String(i), label: p.label }))}
              onChange={(e) => {
                const p = PRESETS[Number(e.target.value)];
                if (p)
                  setForm((f) => ({
                    ...f,
                    from: p.from,
                    fromName: p.fromName,
                    subject: p.subject,
                    text: p.text,
                  }));
              }}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From address">
            {(id) => (
              <Input
                id={id}
                type="email"
                value={form.from}
                onChange={set('from')}
                placeholder="rep@vendor.com"
              />
            )}
          </Field>
          <Field label="From name">
            {(id) => (
              <Input id={id} value={form.fromName} onChange={set('fromName')} placeholder="Optional" />
            )}
          </Field>
        </div>
        <Field
          label="To"
          hint="Your purchasing mailbox, or a thread reply address (t-…@) to test automatic filing."
        >
          {(id) => <Input id={id} value={form.to} onChange={set('to')} />}
        </Field>
        <Field label="Subject">
          {(id) => <Input id={id} value={form.subject} onChange={set('subject')} />}
        </Field>
        <Field label="Body">
          {(id) => <Textarea id={id} rows={9} value={form.text} onChange={set('text')} />}
        </Field>
        <div>
          <Button
            size="sm"
            variant="secondary"
            icon={<Paperclip className="size-4" />}
            onClick={() => input.current?.click()}
          >
            Attach files
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              setFiles((prev) => [...prev, ...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          {!!files.length && (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${f.size}-${f.lastModified}`}
                  className="flex items-center gap-2 text-[13px]"
                >
                  <Paperclip className="size-3.5 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="num text-ink-3">{fileSize(f.size)}</span>
                  <IconButton
                    label={`Remove ${f.name}`}
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  >
                    <X className="size-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
        {send.isError && (
          <p className="rounded-sm bg-crit-50 px-3 py-2 text-[13px] text-crit">{errorMessage(send.error)}</p>
        )}
      </form>
    </Sheet>
  );
}
