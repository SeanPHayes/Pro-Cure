import { useMutation } from '@tanstack/react-query';
import { Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Dialog, EmptyState, Field, IconButton, Input, Section } from '@/components/ui';
import { api } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { useInvalidateOrders } from '../shared';
import type { PoDetail, Recipient } from '../types';

/** People emailed when tracking is added: project-wide entries cover every PO; others are for this PO only. */
export function RecipientsTab({ po }: { po: PoDetail }) {
  const s = useSession();
  const canWrite = hasPerm(s, 'logistics:write');
  const invalidate = useInvalidateOrders();
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState(false);
  const base = `/projects/${po.projectId}/delivery-recipients`;
  const remove = useMutation({
    mutationFn: (r: Recipient) => api.del('orders', `${base}/${r.id}`),
    onSuccess: (_d, r) => {
      toast.success(`${r.name} removed`);
      invalidate();
    },
  });
  const projectWide = po.recipients.filter((r) => !r.poId);
  const thisPo = po.recipients.filter((r) => r.poId);
  const list = (rows: Recipient[], title: string, hint: string) => (
    <Section title={title} bodyClassName="">
      <p className="border-b border-line-2 px-4 py-2 text-[13px] text-ink-3">{hint}</p>
      {!rows.length ? (
        <p className="px-4 py-3 text-ink-3">None.</p>
      ) : (
        <ul className="divide-y divide-line-2">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="font-[560]">{r.name}</div>
                <div className="truncate text-[13px] text-ink-2">
                  {[r.email, r.phone].filter(Boolean).join(' · ') || 'No contact details'}
                </div>
              </div>
              {canWrite && (
                <IconButton label={`Remove ${r.name}`} onClick={() => remove.mutate(r)}>
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-[70ch] text-ink-2">
          Delivery recipients get an email with the carrier and tracking link as soon as tracking is added, so
          the site or warehouse is ready to receive.
        </p>
        {canWrite && (
          <div className="flex gap-2">
            <Button icon={<Users className="size-4" />} onClick={() => setBulk(true)}>
              Apply list to project
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              Add recipient
            </Button>
          </div>
        )}
      </div>
      {!po.recipients.length ? (
        <Section>
          <EmptyState icon={<Users />} title="No delivery recipients">
            Add the site superintendent or warehouse receiving desk so they hear about every shipment.
          </EmptyState>
        </Section>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {list(
            projectWide,
            'Every order on this project',
            'Notified for all purchase orders on the project.',
          )}
          {list(thisPo, `Only ${po.number}`, 'Notified for this purchase order only.')}
        </div>
      )}
      <AddDialog po={po} open={adding} onClose={() => setAdding(false)} />
      <BulkDialog po={po} open={bulk} onClose={() => setBulk(false)} />
    </div>
  );
}

function AddDialog({ po, open, onClose }: { po: PoDetail; open: boolean; onClose: () => void }) {
  const invalidate = useInvalidateOrders();
  const [f, setF] = useState({ name: '', email: '', phone: '', onlyThis: false });
  const m = useMutation({
    mutationFn: () =>
      api.post('orders', `/projects/${po.projectId}/delivery-recipients`, {
        name: f.name.trim(),
        email: f.email.trim() || null,
        phone: f.phone.trim() || null,
        poId: f.onlyThis ? po.id : null,
      }),
    onSuccess: () => {
      toast.success(`${f.name} added`);
      setF({ name: '', email: '', phone: '', onlyThis: false });
      invalidate();
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add delivery recipient"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!f.name.trim()}
            onClick={() => m.mutate()}
          >
            Add recipient
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          {(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
        </Field>
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
            />
          )}
        </Field>
        <Field label="Phone">
          {(id) => (
            <Input
              id={id}
              type="tel"
              value={f.phone}
              onChange={(e) => setF({ ...f, phone: e.target.value })}
            />
          )}
        </Field>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-4 accent-lacquer"
            checked={f.onlyThis}
            onChange={(e) => setF({ ...f, onlyThis: e.target.checked })}
          />
          Only for {po.number} (otherwise every order on the project)
        </label>
      </div>
    </Dialog>
  );
}

function BulkDialog({ po, open, onClose }: { po: PoDetail; open: boolean; onClose: () => void }) {
  const invalidate = useInvalidateOrders();
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(false);
  const parsed = text
    .split('\n')
    .map((l) => l.split(/[,;\t]/).map((x) => x.trim()))
    .filter((p) => p[0])
    .map(([name, email, phone]) => ({ name: name!, email: email || null, phone: phone || null }));
  const m = useMutation({
    mutationFn: () =>
      api.post<{ purchaseOrders: number }>(
        'orders',
        `/projects/${po.projectId}/delivery-recipients/bulk-apply`,
        {
          recipients: parsed,
          replaceExisting: replace,
        },
      ),
    onSuccess: (r) => {
      toast.success(`Recipients applied to ${r.purchaseOrders} purchase orders`);
      invalidate();
      setText('');
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={540}
      title={`Apply recipients to every order on ${po.projectName ?? 'the project'}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!parsed.length}
            onClick={() => m.mutate()}
          >
            Apply {parsed.length || ''} recipients
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="One per line: name, email, phone" hint={`${parsed.length} recipients`}>
          {(id) => (
            <textarea
              id={id}
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                'Carl Mendes, carl@riverfronthm.example, (910) 555-0166\nPort City Warehousing, receiving@portcitywh.example'
              }
              className="w-full rounded-sm border border-line bg-paper px-2.5 py-2 font-mono text-[13px] focus:border-lacquer focus:outline-none"
            />
          )}
        </Field>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-4 accent-lacquer"
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
          />
          Replace the existing recipients (project-wide and per order)
        </label>
      </div>
    </Dialog>
  );
}
