import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { uploadDocument } from '@/components/shared/DocumentsPanel';
import { Button, Chips, Field, Select, Sheet, Spinner } from '@/components/ui';
import { api, type Page } from '@/lib/api';
import { date } from '@/lib/format';
import { friendlyError, isServiceDown } from '../catalog/shared';
import { isPdf, PdfPicker } from './BrandSpecImportSheet';
import type { Job } from './shared';

interface CostRequestRow {
  id: string;
  number: string;
  quoteId: string;
  quoteNumber: string | null;
  quoteName: string | null;
  vendorId: string;
  vendorName: string | null;
  status: string;
  dueDate: string | null;
  lineCount: number;
}
interface QuoteRow {
  id: string;
  number: string;
  name: string;
  status: string;
  isTemplate: boolean;
}
interface SpecRow {
  id: string;
  code: string;
  name: string;
  vendorName: string | null;
}

const OPEN_CR = new Set(['sent', 'viewed', 'responded']);

/** The quoting service may not be reachable; say so and keep the rest of the workspace usable. */
function QuotingDown({ error }: { error: unknown }) {
  return (
    <div
      role="alert"
      className="rounded-sm border border-warn/25 bg-warn-50 px-3 py-2 text-[13px] text-ink-2"
    >
      <span className="font-[620] text-ink">Quoting is unavailable right now.</span>{' '}
      {isServiceDown(error)
        ? 'Cost requests and quotes can’t be loaded, so this tool can’t start. Try again in a few minutes.'
        : friendlyError(error, 'Quoting')}
    </div>
  );
}

export function VendorQuoteSheet({
  open,
  onClose,
  defaultCostRequestId,
}: {
  open: boolean;
  onClose: () => void;
  defaultCostRequestId?: string;
}) {
  const nav = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [crId, setCrId] = useState(defaultCostRequestId ?? '');
  useEffect(() => {
    if (open) setFile(null);
  }, [open]);
  const crs = useQuery({
    queryKey: ['quoting', 'cost-requests', 'open'],
    queryFn: () => api.get<Page<CostRequestRow>>('quoting', '/cost-requests', { limit: 200 }),
    select: (d) => d.items.filter((x) => OPEN_CR.has(x.status)),
    enabled: open,
    meta: { silent: true },
    retry: false,
  });
  const start = useMutation({
    mutationFn: async () => {
      if (!file || !isPdf(file)) throw new Error('Choose the vendor’s quote as a PDF');
      const doc = await uploadDocument(file, { kind: 'other', entityType: 'cost_request', entityId: crId });
      return api.post<Job>('ai', '/jobs/vendor-quote', {
        documentId: doc.id,
        costRequestId: crId,
        idempotencyKey: `vq-${doc.id}`,
      });
    },
    onSuccess: (job) => {
      toast.success('Reading started');
      onClose();
      nav(`/app/ai/jobs/${job.id}`);
    },
  });
  const selected = crs.data?.find((x) => x.id === crId);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Read a vendor quote PDF"
      description="Pro-Cure reads the vendor’s prices, lead times and expiry dates and matches each line to your pricing request. You review every match before costs change."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!file || !crId}
            loading={start.isPending}
            onClick={() => start.mutate()}
          >
            Upload and read quote
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Pricing request this quote answers">
          {(id) =>
            crs.isLoading ? (
              <div className="flex h-9 items-center gap-2 text-ink-3">
                <Spinner className="size-4" /> Loading open pricing requests
              </div>
            ) : crs.isError ? (
              <QuotingDown error={crs.error} />
            ) : !crs.data?.length ? (
              <p className="text-ink-3">
                No open pricing requests. Send a cost request to a vendor first, then read their reply here.
              </p>
            ) : (
              <Select
                id={id}
                value={crId}
                onChange={(e) => setCrId(e.target.value)}
                placeholder="Choose a pricing request"
                options={crs.data.map((x) => ({
                  value: x.id,
                  label: `${x.number} · ${x.vendorName ?? 'Vendor'} · ${x.lineCount} ${x.lineCount === 1 ? 'line' : 'lines'}`,
                }))}
              />
            )
          }
        </Field>
        {selected && (
          <p className="-mt-3 text-[13px] text-ink-3">
            {selected.quoteNumber} {selected.quoteName}
            {selected.dueDate ? ` · due ${date(selected.dueDate)}` : ''}
          </p>
        )}
        <PdfPicker file={file} onFile={setFile} />
      </div>
    </Sheet>
  );
}

export function DrawingSplitSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [by, setBy] = useState<'quote' | 'specs'>('quote');
  const [quoteId, setQuoteId] = useState('');
  const [specIds, setSpecIds] = useState<string[]>([]);
  useEffect(() => {
    if (open) setFile(null);
  }, [open]);
  const quotes = useQuery({
    queryKey: ['quoting', 'quotes', 'for-split'],
    queryFn: () => api.get<Page<QuoteRow>>('quoting', '/quotes', { limit: 200, isTemplate: 'false' }),
    select: (d) => d.items,
    enabled: open && by === 'quote',
    meta: { silent: true },
    retry: false,
  });
  const specs = useQuery({
    queryKey: ['quoting', 'specs', 'for-split'],
    queryFn: () => api.get<Page<SpecRow>>('quoting', '/specs', { limit: 500 }),
    select: (d) => d.items,
    enabled: open && by === 'specs',
    meta: { silent: true },
    retry: false,
  });
  const start = useMutation({
    mutationFn: async () => {
      if (!file || !isPdf(file)) throw new Error('Choose the drawing packet as a PDF');
      const doc = await uploadDocument(file, {
        kind: 'shop_drawing',
        entityType: by === 'quote' ? 'quote' : undefined,
        entityId: by === 'quote' ? quoteId : undefined,
      });
      return api.post<Job>('ai', '/jobs/drawing-split', {
        documentId: doc.id,
        ...(by === 'quote' ? { quoteId } : { specIds }),
      });
    },
    onSuccess: (job) => {
      toast.success('Split started');
      onClose();
      nav(`/app/ai/jobs/${job.id}`);
    },
  });
  const q = by === 'quote' ? quotes : specs;
  const ready = !!file && (by === 'quote' ? !!quoteId : specIds.length > 0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Split a drawing packet"
      description="Vendors often send one PDF with every line drawing. Pro-Cure finds which pages belong to which spec and files one drawing per spec after you check it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={start.isPending}
            onClick={() => start.mutate()}
          >
            Upload and split packet
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <div className="mb-1.5 text-[13px] font-[560] text-ink-2">Match pages against</div>
          <Chips
            value={by}
            onChange={setBy}
            options={[
              { value: 'quote', label: 'Specs on a quote' },
              { value: 'specs', label: 'Specs I choose' },
            ]}
          />
        </div>
        {q.isError ? (
          <QuotingDown error={q.error} />
        ) : q.isLoading ? (
          <div className="flex items-center gap-2 text-ink-3">
            <Spinner className="size-4" /> Loading
          </div>
        ) : by === 'quote' ? (
          <Field label="Quote">
            {(id) => (
              <Select
                id={id}
                value={quoteId}
                onChange={(e) => setQuoteId(e.target.value)}
                placeholder="Choose a quote"
                options={(quotes.data ?? []).map((x) => ({ value: x.id, label: `${x.number} · ${x.name}` }))}
              />
            )}
          </Field>
        ) : (
          <Field label="Specs" hint={`${specIds.length} selected. Hold Ctrl or ⌘ to pick several.`}>
            {(id) => (
              <select
                id={id}
                multiple
                value={specIds}
                onChange={(e) => setSpecIds([...e.target.selectedOptions].map((o) => o.value))}
                className="h-56 w-full rounded-sm border border-line bg-paper p-1 focus:border-lacquer focus:outline-none"
              >
                {(specs.data ?? []).map((x) => (
                  <option key={x.id} value={x.id} className="rounded-xs px-2 py-1">
                    {x.code} — {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <PdfPicker file={file} onFile={setFile} />
      </div>
    </Sheet>
  );
}
