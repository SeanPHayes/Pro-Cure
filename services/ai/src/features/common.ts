import { unprocessable } from '@procure/platform';
import { getDocumentContent } from '../clients.js';
import { type PdfText, pdfText } from '../text/extract.js';

/** Fetch a document's bytes from the documents service and check it is a PDF. */
export async function loadPdf(tenantId: string, documentId: string) {
  const doc = await getDocumentContent(tenantId, documentId);
  const bytes = Buffer.from(doc.base64, 'base64');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
    throw unprocessable(`Document "${doc.filename}" is not a PDF (${doc.contentType})`);
  return { filename: doc.filename, bytes: new Uint8Array(bytes) };
}

export async function loadPdfText(
  tenantId: string,
  documentId: string,
): Promise<PdfText & { filename: string; bytes: Uint8Array }> {
  const { filename, bytes } = await loadPdf(tenantId, documentId);
  const text = await pdfText().extract(bytes, { tenantId, filename });
  return { ...text, filename, bytes };
}

/**
 * Reviewer decisions. Saved with POST /jobs/:id/review and/or sent with apply:
 *   review.items = [{ index, accepted, edits }]
 * Apply-time `indexes` (explicit selection) and `edits` override what was saved.
 */
export interface ReviewItem {
  index: number;
  accepted?: boolean;
  edits?: Record<string, unknown>;
}

export function selectItems<T extends Record<string, unknown>>(
  list: T[],
  review: { items?: ReviewItem[] } | null | undefined,
  indexes?: number[] | null,
  edits?: { index: number; set: Record<string, unknown> }[] | null,
): { index: number; item: T }[] {
  const saved = new Map((review?.items ?? []).map((r) => [r.index, r]));
  for (const i of indexes ?? [])
    if (!Number.isInteger(i) || i < 0 || i >= list.length) throw unprocessable(`Index ${i} is out of range`);
  const chosen = indexes?.length
    ? [...new Set(indexes)].sort((a, b) => a - b)
    : list.map((_, i) => i).filter((i) => saved.get(i)?.accepted !== false);
  const late = new Map((edits ?? []).map((e) => [e.index, e.set]));
  return chosen.map((index) => ({
    index,
    item: { ...list[index]!, ...(saved.get(index)?.edits ?? {}), ...(late.get(index) ?? {}) } as T,
  }));
}

export const errorMessage = (err: unknown) => {
  if (err instanceof Error) return err.message.slice(0, 2000);
  return String(err).slice(0, 2000);
};

/** Thrown by an apply that made some changes before failing; the partial result is saved so a retry resumes. */
export class PartialApplyError extends Error {
  constructor(
    public readonly original: unknown,
    public readonly partial: Record<string, unknown>,
  ) {
    super(errorMessage(original));
    this.name = 'PartialApplyError';
  }
}
