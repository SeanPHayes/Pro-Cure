import { useMutation, useQuery } from '@tanstack/react-query';
import { FileText, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { uploadDocument } from '@/components/shared/DocumentsPanel';
import { Button, cx, Field, Input, Select, Sheet } from '@/components/ui';
import { api, type Page } from '@/lib/api';
import { type BrandStandard, useBrands } from '../catalog/shared';
import type { Job } from './shared';

const fmtSize = (b: number) =>
  b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

/** Pick a PDF, a little context, upload it and start a brand-spec reading job. */
export function PdfPicker({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop zone; the "choose a file" button is the keyboard path
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={cx(
        'rounded-sm border border-dashed px-4 py-5',
        dragging ? 'border-brass bg-brass-50' : file ? 'border-lacquer/40 bg-lacquer-50' : 'border-line',
      )}
    >
      {file ? (
        <div className="flex items-center gap-3">
          <FileText className="size-5 shrink-0 text-lacquer" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-[560]">{file.name}</div>
            <div className="text-[12px] text-ink-3">{fmtSize(file.size)}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
            Choose another
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 text-center">
          <Upload className="size-5 text-ink-3" />
          <div className="text-ink-2">
            Drop a PDF here or{' '}
            <button
              type="button"
              className="font-[560] text-lacquer hover:underline"
              onClick={() => input.current?.click()}
            >
              choose a file
            </button>
          </div>
          <div className="text-[12px] text-ink-3">Text-based PDFs up to 200 MB</div>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

export const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

export function BrandSpecImportSheet({
  open,
  onClose,
  defaultStandardId,
  defaultBrandId,
}: {
  open: boolean;
  onClose: () => void;
  defaultStandardId?: string;
  defaultBrandId?: string;
}) {
  const nav = useNavigate();
  const brands = useBrands();
  const [file, setFile] = useState<File | null>(null);
  const [brandId, setBrandId] = useState(defaultBrandId ?? '');
  const [standardId, setStandardId] = useState(defaultStandardId ?? '');
  const [name, setName] = useState('');
  const drafts = useQuery({
    queryKey: ['catalog', 'standards', { mine: true, editable: true }],
    queryFn: () =>
      api.get<Page<BrandStandard>>('catalog', '/brand-standards', {
        mine: true,
        status: 'draft',
        limit: 200,
      }),
    enabled: open,
    select: (d) => d.items,
  });

  const start = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a PDF to read');
      if (!isPdf(file))
        throw new Error(`${file.name} is not a PDF. Export the brand standard as a PDF first.`);
      const doc = await uploadDocument(file, {
        kind: 'other',
        entityType: standardId ? 'brand_standard' : undefined,
        entityId: standardId || undefined,
      });
      return api.post<Job>('ai', '/jobs/brand-spec', {
        documentId: doc.id,
        brandId: brandId || undefined,
        standardId: standardId || undefined,
        standardName: name.trim() || undefined,
      });
    },
    onSuccess: (job) => {
      toast.success('Reading started', { description: 'Review the extracted items when it finishes.' });
      onClose();
      setFile(null);
      nav(`/app/ai/jobs/${job.id}`);
    },
  });

  const draftOptions = (drafts.data ?? [])
    .filter((s) => !brandId || s.brandId === brandId)
    .map((s) => ({ value: s.id, label: `${s.name} (v${s.version})` }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Import a brand standard from PDF"
      description="Pro-Cure reads the PDF into structured items. Nothing changes until you review and apply them."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!file} loading={start.isPending} onClick={() => start.mutate()}>
            Upload and read PDF
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <PdfPicker file={file} onFile={setFile} />
        <Field label="Brand" hint="Optional. Helps name the package and pick where to apply it.">
          {(id) => (
            <Select
              id={id}
              value={brandId}
              onChange={(e) => {
                setBrandId(e.target.value);
                setStandardId('');
              }}
              placeholder="Detect from the PDF"
              options={(brands.data ?? []).map((b) => ({
                value: b.id,
                label: b.parentCompany ? `${b.name} (${b.parentCompany})` : b.name,
              }))}
            />
          )}
        </Field>
        <Field label="Package name" hint="Optional. Used if the PDF doesn’t state one.">
          {(id) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Hampton by Hilton – Guestroom FF&E 2026"
            />
          )}
        </Field>
        <Field
          label="Update an existing draft"
          hint={
            draftOptions.length
              ? 'Optional. You can also choose or create the target package when you apply.'
              : 'Your firm has no draft packages yet. You can create one when you apply.'
          }
        >
          {(id) => (
            <Select
              id={id}
              value={standardId}
              onChange={(e) => setStandardId(e.target.value)}
              placeholder="Decide when applying"
              options={draftOptions}
              disabled={!draftOptions.length}
            />
          )}
        </Field>
      </div>
    </Sheet>
  );
}
