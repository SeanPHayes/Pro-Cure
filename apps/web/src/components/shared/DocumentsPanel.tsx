import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Image as ImageIcon, Paperclip, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { cx, EmptyState, IconButton, Select, Spinner } from '@/components/ui';
import { api, documentUrl } from '@/lib/api';
import { ago, humanize } from '@/lib/format';

export interface DocumentRow {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  kind: string;
  entityType: string | null;
  entityId: string | null;
  visibility: 'internal' | 'vendor' | 'client';
  vendorOrgId: string | null;
  clientOrgId: string | null;
  includeInSpecBook: boolean;
  pageCount: number | null;
  createdAt: string;
  uploadedByName: string | null;
}

const KINDS = [
  'spec_sheet',
  'line_drawing',
  'shop_drawing',
  'finish_sample',
  'cfa',
  'approval_form',
  'image',
  'photo',
  'contract',
  'other',
];

const fmtSize = (b: number) =>
  b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

export const uploadDocument = (
  file: File,
  fields: Record<string, string | boolean | null | undefined>,
): Promise<DocumentRow> => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.append(k, String(v));
  form.append('file', file);
  return api.upload<DocumentRow>('documents', '/documents', form);
};

/**
 * Files attached to any record. Drag-and-drop or pick files; set kind and who can see them; toggle
 * "include in spec book" for spec documents.
 */
export function DocumentsPanel({
  entityType,
  entityId,
  defaultKind = 'other',
  visibility = 'internal',
  vendorOrgId,
  clientOrgId,
  showSpecBookToggle,
  readOnly,
}: {
  entityType: string;
  entityId: string;
  defaultKind?: string;
  visibility?: 'internal' | 'vendor' | 'client';
  vendorOrgId?: string | null;
  clientOrgId?: string | null;
  showSpecBookToggle?: boolean;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const key = ['documents', entityType, entityId];
  const docs = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<{ items: DocumentRow[] } | DocumentRow[]>('documents', '/documents', { entityType, entityId }),
    select: (d) => (Array.isArray(d) ? d : d.items),
  });
  const [kind, setKind] = useState(defaultKind);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files)
        await uploadDocument(f, {
          entityType,
          entityId,
          kind,
          visibility,
          vendorOrgId,
          clientOrgId,
          includeInSpecBook: showSpecBookToggle ? kind !== 'image' : undefined,
        });
    },
    onSuccess: (_d, files) => {
      toast.success(files.length === 1 ? `Uploaded ${files[0]!.name}` : `Uploaded ${files.length} files`);
      qc.invalidateQueries({ queryKey: key });
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string; includeInSpecBook?: boolean; visibility?: string }) =>
      api.patch('documents', `/documents/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del('documents', `/documents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const onFiles = (list: FileList | null) => list?.length && upload.mutate([...list]);

  return (
    <div>
      {!readOnly && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            onFiles(e.dataTransfer.files);
          }}
          className={cx(
            'mb-3 flex flex-wrap items-center gap-3 rounded-sm border border-dashed px-3 py-3',
            dragging ? 'border-brass bg-brass-50' : 'border-line',
          )}
        >
          <Upload className="size-4 text-ink-3" />
          <span className="flex-1 text-ink-2">
            Drop files here or{' '}
            <button
              type="button"
              className="font-[560] text-lacquer hover:underline"
              onClick={() => input.current?.click()}
            >
              choose files
            </button>
          </span>
          <div className="w-44">
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              options={KINDS.map((k) => ({ value: k, label: humanize(k) }))}
            />
          </div>
          {upload.isPending && <Spinner className="size-4" />}
          <input ref={input} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
        </div>
      )}
      {docs.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : !docs.data?.length ? (
        <EmptyState icon={<Paperclip />} title="No files yet">
          {readOnly
            ? 'Files shared with you will appear here.'
            : 'Spec sheets, drawings, photos and approvals live here.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-2">
          {docs.data.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2">
              {d.contentType.startsWith('image/') ? (
                <ImageIcon className="size-4 shrink-0 text-ink-3" />
              ) : (
                <FileText className="size-4 shrink-0 text-ink-3" />
              )}
              <div className="min-w-0 flex-1">
                <a
                  href={documentUrl(d.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-[560] hover:text-lacquer hover:underline"
                >
                  {d.filename}
                </a>
                <div className="text-[12px] text-ink-3">
                  {humanize(d.kind)} · {fmtSize(d.size)}
                  {d.pageCount ? ` · ${d.pageCount} pages` : ''} · {d.uploadedByName ?? 'System'}{' '}
                  {ago(d.createdAt)}
                </div>
              </div>
              {showSpecBookToggle && !readOnly && (
                <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
                  <input
                    type="checkbox"
                    className="accent-lacquer"
                    checked={d.includeInSpecBook}
                    onChange={(e) => patch.mutate({ id: d.id, includeInSpecBook: e.target.checked })}
                  />
                  Spec book
                </label>
              )}
              {d.visibility !== 'internal' && (
                <span className="text-[12px] text-brass">Shared with {d.visibility}</span>
              )}
              {!readOnly && (
                <IconButton label={`Delete ${d.filename}`} onClick={() => remove.mutate(d.id)}>
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
