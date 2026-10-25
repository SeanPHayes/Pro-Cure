import type { z } from '@procure/platform';
import { badRequest, storage, type Tx } from '@procure/platform';
import type { ReportTemplate } from '../schemas.js';
import { findDocument } from '../store.js';
import { claimDoc } from './claim.js';
import { costRequestDoc } from './cost_request.js';
import { TEMPLATE_DATA } from './data.js';
import { invoiceDoc } from './invoice.js';
import { renderPdf } from './pdf.js';
import { poRevisionDoc } from './po_revision.js';
import { purchaseOrderDoc } from './purchase_order.js';
import { quoteDoc } from './quote.js';
import { scheduleDoc } from './schedule.js';
import { type AttachmentLoader, renderSpecBook } from './spec_book.js';

export interface Rendered {
  buffer: Buffer;
  pageCount: number | null;
}

/** Validate a template's data, returning 400 with one entry per issue (path → message). */
export function parseTemplateData<T extends ReportTemplate>(template: T, data: unknown) {
  const schema = TEMPLATE_DATA[template];
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw badRequest(
      `Invalid data for the ${template} template`,
      parsed.error.issues.map((i) => ({ path: ['data', ...i.path].join('.'), message: i.message })),
    );
  return parsed.data as z.infer<(typeof TEMPLATE_DATA)[T]>;
}

/**
 * Loader used by the spec book: reads an attached document under the caller's RLS context so a spec
 * book can only merge files the caller can see.
 */
export const tenantLoader =
  (tx: Tx): AttachmentLoader =>
  async (id) => {
    const doc = await findDocument(tx, id);
    if (!doc) return null;
    return {
      id,
      filename: doc.filename,
      contentType: doc.contentType,
      bytes: await storage().get(doc.storageKey),
    };
  };

export async function renderTemplate(
  template: ReportTemplate,
  data: unknown,
  load: AttachmentLoader,
  generatedAt = new Date(),
): Promise<Rendered> {
  switch (template) {
    case 'quote':
      return {
        buffer: await renderPdf(quoteDoc(parseTemplateData('quote', data), generatedAt)),
        pageCount: null,
      };
    case 'purchase_order':
      return {
        buffer: await renderPdf(
          purchaseOrderDoc(parseTemplateData('purchase_order', data), { revision: false }, generatedAt),
        ),
        pageCount: null,
      };
    case 'po_revision':
      return {
        buffer: await renderPdf(poRevisionDoc(parseTemplateData('po_revision', data), generatedAt)),
        pageCount: null,
      };
    case 'schedule':
      return {
        buffer: await renderPdf(scheduleDoc(parseTemplateData('schedule', data), generatedAt)),
        pageCount: null,
      };
    case 'cost_request':
      return {
        buffer: await renderPdf(costRequestDoc(parseTemplateData('cost_request', data), generatedAt)),
        pageCount: null,
      };
    case 'invoice':
      return {
        buffer: await renderPdf(invoiceDoc(parseTemplateData('invoice', data), generatedAt)),
        pageCount: null,
      };
    case 'claim':
      return {
        buffer: await renderPdf(claimDoc(parseTemplateData('claim', data), generatedAt)),
        pageCount: null,
      };
    case 'spec_book': {
      const r = await renderSpecBook(parseTemplateData('spec_book', data), load, generatedAt);
      return { buffer: r.buffer, pageCount: r.pageCount };
    }
  }
}

export const TEMPLATES = Object.keys(TEMPLATE_DATA) as ReportTemplate[];
