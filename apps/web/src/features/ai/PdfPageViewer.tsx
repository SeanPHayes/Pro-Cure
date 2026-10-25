import { ChevronLeft, ChevronRight, ExternalLink, FileText } from 'lucide-react';
import { cx, IconButton } from '@/components/ui';
import { documentUrl } from '@/lib/api';

/**
 * The source PDF beside a review table, opened at a page. Uses the browser's own PDF viewer through an
 * iframe (#page=N); changing page reloads the frame so every browser honours the fragment.
 */
export function PdfPageViewer({
  documentId,
  page,
  pageCount,
  onPage,
  label,
  className,
}: {
  documentId: string;
  page: number;
  pageCount?: number | null;
  onPage: (p: number) => void;
  label?: string;
  className?: string;
}) {
  const src = `${documentUrl(documentId)}#page=${page}&view=FitH`;
  const max = pageCount ?? Number.POSITIVE_INFINITY;
  return (
    <div className={cx('flex flex-col overflow-hidden rounded-md border border-line bg-paper', className)}>
      <div className="flex items-center gap-1 border-b border-line-2 px-2 py-1.5">
        <FileText className="ml-1 size-4 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate px-1 text-[13px] font-[560]">{label ?? 'Source PDF'}</span>
        <IconButton label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="size-4" />
        </IconButton>
        <span className="num min-w-[64px] text-center text-[13px] text-ink-2">
          Page {page}
          {pageCount ? ` of ${pageCount}` : ''}
        </span>
        <IconButton label="Next page" disabled={page >= max} onClick={() => onPage(page + 1)}>
          <ChevronRight className="size-4" />
        </IconButton>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          aria-label="Open the PDF in a new tab"
          title="Open the PDF in a new tab"
          className="inline-grid size-8 place-items-center rounded-sm text-ink-2 hover:bg-stone-2 hover:text-ink"
        >
          <ExternalLink className="size-4" />
        </a>
      </div>
      <iframe
        key={page}
        title={`Source PDF, page ${page}`}
        src={src}
        className="min-h-0 w-full flex-1 bg-stone-2"
      />
    </div>
  );
}
