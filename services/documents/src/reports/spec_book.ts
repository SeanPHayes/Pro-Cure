import type { z } from '@procure/platform';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { SpecBookData } from './data.js';
import {
  addressLines,
  C,
  CONTENT_WIDTH,
  dataTable,
  date,
  dateTime,
  documentShell,
  type Field,
  fieldGrid,
  humanize,
  label,
  type Node,
  qty,
  renderPdf,
  rule,
  text,
} from './pdf.js';

type Data = z.infer<typeof SpecBookData>;
type Spec = Data['specs'][number];

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/** Resolves a document id to its bytes (tenant-scoped); null when missing or not visible. */
export type AttachmentLoader = (id: string) => Promise<Attachment | null>;

interface Prepared {
  id: string;
  filename: string;
  pages: number;
  /** A loaded PDF (or an image wrapped as a one-page PDF) ready to copy pages from. */
  pdf: PDFDocument | null;
  error?: string;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

/** Turn an attachment into a PDF we can copy pages from. Images become one letter-size page. */
async function prepare(a: Attachment): Promise<Prepared> {
  try {
    if (a.contentType === 'application/pdf') {
      const pdf = await PDFDocument.load(a.bytes, { ignoreEncryption: true, updateMetadata: false });
      return { id: a.id, filename: a.filename, pages: pdf.getPageCount(), pdf };
    }
    if (IMAGE_TYPES.has(a.contentType)) {
      const pdf = await PDFDocument.create();
      const img = a.contentType === 'image/png' ? await pdf.embedPng(a.bytes) : await pdf.embedJpg(a.bytes);
      const page = pdf.addPage([612, 792]);
      const scale = Math.min((612 - 72) / img.width, (792 - 108) / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (612 - w) / 2, y: (792 - h) / 2 + 10, width: w, height: h });
      return { id: a.id, filename: a.filename, pages: 1, pdf };
    }
    return { id: a.id, filename: a.filename, pages: 0, pdf: null, error: 'not a PDF or image' };
  } catch (err) {
    return {
      id: a.id,
      filename: a.filename,
      pages: 0,
      pdf: null,
      error: `unreadable (${(err as Error).message.slice(0, 60)})`,
    };
  }
}

const anchor = (i: number) => `spec-${i}`;

function specPage(s: Spec, i: number, attachments: Prepared[]): Node {
  const fields: Field[] = [
    { label: 'Category', value: s.category ? humanize(s.category) : null },
    { label: 'Vendor', value: s.vendor },
    { label: 'Location', value: s.location },
    { label: 'Quantity', value: s.quantity !== null && s.quantity !== undefined ? qty(s.quantity) : null },
    { label: 'Dimensions', value: s.dimensions },
    { label: 'Finish', value: s.finish },
  ];
  return {
    pageBreak: 'before',
    stack: [
      {
        id: anchor(i),
        columns: [
          { width: 'auto', text: s.code, fontSize: 22, bold: true, color: C.accent },
          { width: '*', text: s.name, fontSize: 15, bold: true, color: C.ink, margin: [12, 5, 0, 0] },
        ],
      },
      rule(10, 12),
      fieldGrid(fields, 3),
      ...(s.materials ? [label('Materials'), { text: s.materials, fontSize: 9, margin: [0, 0, 0, 10] }] : []),
      ...(s.description
        ? [
            label('Description'),
            { text: s.description, fontSize: 9, lineHeight: 1.35, margin: [0, 0, 0, 10] },
          ]
        : []),
      ...(s.notes ? [label('Notes'), { text: s.notes, fontSize: 9, margin: [0, 0, 0, 10] }] : []),
      ...(attachments.length
        ? [
            label('Attached documents'),
            dataTable(
              [
                { header: 'Document', value: (a: Prepared) => a.filename },
                {
                  header: 'Pages',
                  width: 60,
                  align: 'right',
                  value: (a) => (a.pdf ? String(a.pages) : { text: a.error ?? 'not merged', color: C.red }),
                },
              ],
              attachments,
            ),
          ]
        : []),
    ],
  };
}

function definition(d: Data, prepared: Prepared[][], tocPages: number[] | null, generatedAt: Date) {
  const subtitle = [d.quote?.number, d.quote?.name].filter(Boolean).join(' · ');
  const cover: Node = {
    stack: [
      {
        text: d.tenant.name.toUpperCase(),
        fontSize: 9,
        bold: true,
        color: C.accent,
        characterSpacing: 1.5,
        margin: [0, 150, 0, 14],
      },
      { text: 'Specification Book', fontSize: 30, bold: true, color: C.ink },
      { text: d.project.name, fontSize: 16, color: C.body, margin: [0, 8, 0, 2] },
      ...[d.project.propertyName, ...addressLines(d.project.address)]
        .filter(Boolean)
        .map((l) => ({ text: l, fontSize: 10, color: C.muted })),
      rule(28, 18),
      {
        columns: [
          { stack: [label('Project'), { text: text(d.project.number), fontSize: 10, color: C.ink }] },
          { stack: [label('Quote'), { text: subtitle || '—', fontSize: 10, color: C.ink }] },
          {
            stack: [
              label('Date'),
              { text: date(d.date ?? generatedAt.toISOString()), fontSize: 10, color: C.ink },
            ],
          },
          { stack: [label('Specifications'), { text: String(d.specs.length), fontSize: 10, color: C.ink }] },
        ],
      },
      {
        text: [d.tenant.phone, d.tenant.email].filter(Boolean).join('  ·  '),
        fontSize: 8.5,
        color: C.muted,
        margin: [0, 200, 0, 0],
      },
    ],
  };

  const toc: Node = {
    pageBreak: 'before',
    stack: [
      { text: 'Contents', style: 'h1', margin: [0, 0, 0, 12] },
      dataTable(
        [
          { header: 'Code', width: 60, value: (s: Spec) => s.code, strong: true },
          { header: 'Specification', value: (s) => s.name },
          { header: 'Location', width: 110, value: (s) => text(s.location) },
          { header: 'Docs', width: 34, align: 'right', value: (_s, i) => String(prepared[i]?.length ?? 0) },
          {
            header: 'Page',
            width: 36,
            align: 'right',
            value: (_s, i) => ({
              text: tocPages ? String(tocPages[i]) : '000',
              linkToDestination: anchor(i),
            }),
          },
        ],
        d.specs,
      ),
    ],
  };

  const def = documentShell({
    title: 'Specification Book',
    subject: `Spec book · ${d.project.name}`,
    tenantName: d.tenant.name,
    content: [cover, toc, ...d.specs.map((s, i) => specPage(s, i, prepared[i] ?? []))],
    generatedAt,
    footerNumbers: false,
  });
  return def;
}

/** Render the spec pages and capture the page each spec starts on (1-based, pdfmake numbering). */
async function renderPass(d: Data, prepared: Prepared[][], tocPages: number[] | null, generatedAt: Date) {
  const starts: number[] = new Array(d.specs.length).fill(0);
  const def = definition(d, prepared, tocPages, generatedAt);
  def.pageBreakBefore = (node: { id?: string; pageNumbers: number[] }) => {
    const m = node.id ? /^spec-(\d+)$/.exec(node.id) : null;
    if (m) starts[Number(m[1])] = node.pageNumbers[0] ?? 0;
    return false;
  };
  const buf = await renderPdf(def);
  return { buf, starts };
}

/**
 * Cover, contents, one page per spec, each followed by that spec's attached documents (PDFs merged
 * page by page, images placed on their own page). Page numbers in the contents and the "Page x of y"
 * footer account for the merged pages.
 */
export async function renderSpecBook(d: Data, load: AttachmentLoader, generatedAt = new Date()) {
  const prepared: Prepared[][] = [];
  for (const s of d.specs) {
    const list: Prepared[] = [];
    for (const id of s.documentIds) {
      const a = await load(id);
      list.push(
        a
          ? await prepare(a)
          : { id, filename: `Document ${id.slice(0, 8)}`, pages: 0, pdf: null, error: 'not found' },
      );
    }
    prepared.push(list);
  }
  const extra = prepared.map((list) => list.reduce((n, a) => n + (a.pdf ? a.pages : 0), 0));

  // Pass 1 learns where each spec starts; pass 2 prints final page numbers (same layout, same pages).
  const first = await renderPass(d, prepared, null, generatedAt);
  const finalPage = (starts: number[]) =>
    starts.map((p, i) => p + extra.slice(0, i).reduce((a, b) => a + b, 0));
  const second = await renderPass(d, prepared, finalPage(first.starts), generatedAt);

  const base = await PDFDocument.load(second.buf);
  const out = await PDFDocument.create();
  out.setTitle(`Spec book · ${d.project.name}`);
  out.setAuthor(d.tenant.name);
  out.setCreator('Pro-Cure');
  out.setProducer('Pro-Cure');
  const baseCount = base.getPageCount();
  const starts = second.starts;
  const copyBase = async (from: number, to: number) => {
    if (to < from) return;
    const idx = Array.from({ length: to - from + 1 }, (_, k) => from - 1 + k);
    for (const p of await out.copyPages(base, idx)) out.addPage(p);
  };
  // Front matter (cover + contents) precedes the first spec.
  await copyBase(1, (starts[0] ?? baseCount + 1) - 1);
  for (let i = 0; i < d.specs.length; i++) {
    const end = i + 1 < starts.length ? (starts[i + 1] ?? baseCount + 1) - 1 : baseCount;
    await copyBase(starts[i] ?? 1, end);
    for (const a of prepared[i] ?? []) {
      if (!a.pdf) continue;
      for (const p of await out.copyPages(a.pdf, a.pdf.getPageIndices())) out.addPage(p);
    }
  }

  // Footer on every page (including merged vendor documents), skipping the cover.
  const font = await out.embedFont(StandardFonts.Helvetica);
  const total = out.getPageCount();
  const stamp = `Generated ${dateTime(generatedAt)} · Pro-Cure`;
  out.getPages().forEach((page, i) => {
    if (i === 0) return;
    const { width } = page.getSize();
    const right = `${d.tenant.name}  ·  Page ${i + 1} of ${total}`;
    const size = 7;
    page.drawText(stamp, { x: 44, y: 22, size, font, color: rgb(0.64, 0.67, 0.73) });
    page.drawText(right, {
      x: width - 44 - font.widthOfTextAtSize(right, size),
      y: 22,
      size,
      font,
      color: rgb(0.41, 0.45, 0.53),
    });
  });

  const bytes = Buffer.from(await out.save());
  return { buffer: bytes, pageCount: total, merged: extra.reduce((a, b) => a + b, 0), width: CONTENT_WIDTH };
}
