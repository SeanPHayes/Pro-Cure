import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  AnalyzeDocumentCommand,
  type Block,
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import { config, storage, storageKey } from '@procure/platform';
import { PDFDocument } from 'pdf-lib';

/**
 * PDF → per-page text with line structure.
 *
 * `LocalPdfText` reads the PDF's text layer with pdfjs (no network). Items are grouped into lines by
 * baseline y (tolerance scaled by font height), sorted by x, and joined with a single space, or with
 * two or more spaces where there is a visible column gap — so table rows survive as
 * `cells` that the heuristics can split on. Pages with (almost) no text are reported as `scanned`.
 *
 * `TextractExtractor` (OCR_PROVIDER=textract) runs the local pass first and OCRs only the scanned
 * pages: a handful synchronously with AnalyzeDocument (one single-page PDF per call), larger sets
 * asynchronously with StartDocumentTextDetection against an S3 object.
 */
export interface PdfLine {
  text: string;
  /** Column cells (split on visible horizontal gaps). */
  cells: string[];
  /** Baseline y from the page bottom (PDF units); 0 for OCR lines without geometry. */
  y: number;
  x: number;
  fontSize: number;
}

export interface PdfPage {
  page: number; // 1-based
  text: string;
  lines: PdfLine[];
  scanned: boolean;
  ocr: boolean;
  width: number;
  height: number;
}

export interface PdfText {
  pageCount: number;
  pages: PdfPage[];
  scannedPages: number[];
  engine: 'pdfjs' | 'pdfjs+textract';
  warnings: string[];
}

export interface PdfTextExtractor {
  readonly name: string;
  extract(bytes: Uint8Array, opts?: { tenantId?: string; filename?: string }): Promise<PdfText>;
}

const require = createRequire(import.meta.url);
const pdfjsRoot = () => dirname(require.resolve('pdfjs-dist/package.json'));

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | undefined;
const loadPdfJs = () => {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
};

/** Minimum characters of real text for a page not to count as scanned. */
const SCANNED_THRESHOLD = 12;

interface RawItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Group positioned text items into lines (exported for unit tests). */
export function itemsToLines(items: RawItem[]): PdfLine[] {
  const visible = items.filter((i) => i.str.trim().length > 0);
  visible.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: RawItem[][] = [];
  for (const it of visible) {
    const row = rows.find((r) => {
      const ref = r[0]!;
      const tol = Math.max(2, Math.min(ref.h, it.h || ref.h) * 0.45);
      return Math.abs(ref.y - it.y) <= tol;
    });
    if (row) row.push(it);
    else rows.push([it]);
  }
  const lines = rows.map((r) => {
    r.sort((a, b) => a.x - b.x);
    const fontSize = Math.max(...r.map((i) => i.h || 0)) || 10;
    const cells: string[] = [];
    let text = '';
    let cell = '';
    let prevEnd: number | null = null;
    for (const it of r) {
      const s = it.str.replace(/\s+/g, ' ');
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        const charW = (it.h || fontSize) * 0.5;
        if (gap > charW * 2.2) {
          cells.push(cell.trim());
          cell = '';
          text += '   ';
        } else if (gap > charW * 0.15 && !text.endsWith(' ') && !s.startsWith(' ')) {
          text += ' ';
          cell += ' ';
        }
      }
      text += s;
      cell += s;
      prevEnd = it.x + (it.w || s.length * (it.h || fontSize) * 0.5);
    }
    cells.push(cell.trim());
    return {
      text: text.replace(/\s+$/, '').replace(/^\s+/, ''),
      cells: cells.filter(Boolean),
      y: r[0]!.y,
      x: r[0]!.x,
      fontSize,
    };
  });
  return lines.filter((l) => l.text.length > 0);
}

export class LocalPdfText implements PdfTextExtractor {
  readonly name = 'pdfjs';
  async extract(bytes: Uint8Array): Promise<PdfText> {
    const pdfjs = await loadPdfJs();
    const root = pdfjsRoot();
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes), // pdfjs transfers/detaches the buffer; always copy
      standardFontDataUrl: `${join(root, 'standard_fonts')}/`,
      cMapUrl: `${join(root, 'cmaps')}/`,
      cMapPacked: true,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    const doc = await task.promise;
    const pages: PdfPage[] = [];
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items: RawItem[] = [];
        for (const it of content.items as any[]) {
          if (typeof it.str !== 'string') continue;
          const t = it.transform as number[];
          items.push({
            str: it.str,
            x: t[4]!,
            y: t[5]!,
            w: it.width ?? 0,
            h: it.height || Math.abs(t[3]!) || 10,
          });
        }
        const lines = itemsToLines(items);
        const text = lines.map((l) => l.text).join('\n');
        pages.push({
          page: n,
          text,
          lines,
          scanned: text.replace(/\s/g, '').length < SCANNED_THRESHOLD,
          ocr: false,
          width: vp.width,
          height: vp.height,
        });
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
    const scannedPages = pages.filter((p) => p.scanned).map((p) => p.page);
    return {
      pageCount: pages.length,
      pages,
      scannedPages,
      engine: 'pdfjs',
      warnings: scannedPages.length
        ? [
            `${scannedPages.length} page(s) have no text layer (scanned): ${scannedPages.join(', ')}. ` +
              'Enable OCR (OCR_PROVIDER=textract) to read them.',
          ]
        : [],
    };
  }
}

/** Convert Textract LINE blocks (one page) to PdfLines ordered top→bottom. */
export function textractLines(blocks: Block[], pageHeight = 792): PdfLine[] {
  return blocks
    .filter((b) => b.BlockType === 'LINE' && b.Text)
    .map((b) => {
      const bb = b.Geometry?.BoundingBox;
      return {
        text: b.Text!,
        cells: b.Text!.split(/\s{2,}/).filter(Boolean),
        y: bb ? (1 - (bb.Top ?? 0)) * pageHeight : 0,
        x: bb ? (bb.Left ?? 0) * 612 : 0,
        fontSize: bb ? (bb.Height ?? 0.012) * pageHeight : 10,
      };
    })
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

export class TextractExtractor implements PdfTextExtractor {
  readonly name = 'textract';
  private client = new TextractClient({ region: config().AWS_REGION });
  constructor(
    private local: PdfTextExtractor = new LocalPdfText(),
    private syncPageLimit = 4,
  ) {}

  async extract(bytes: Uint8Array, opts: { tenantId?: string; filename?: string } = {}): Promise<PdfText> {
    const base = await this.local.extract(bytes);
    if (!base.scannedPages.length) return base;
    const warnings: string[] = [];
    try {
      const ocr =
        base.scannedPages.length <= this.syncPageLimit
          ? await this.syncPages(bytes, base.scannedPages)
          : await this.asyncDocument(bytes, base.scannedPages, opts);
      for (const p of base.pages) {
        const lines = ocr.get(p.page);
        if (!lines) continue;
        p.lines = lines;
        p.text = lines.map((l) => l.text).join('\n');
        p.ocr = true;
        p.scanned = p.text.replace(/\s/g, '').length < SCANNED_THRESHOLD;
      }
    } catch (err) {
      warnings.push(`OCR failed: ${(err as Error).message}`);
    }
    const scannedPages = base.pages.filter((p) => p.scanned).map((p) => p.page);
    if (scannedPages.length) warnings.push(`No text recovered on page(s): ${scannedPages.join(', ')}`);
    return { ...base, scannedPages, engine: 'pdfjs+textract', warnings };
  }

  /** AnalyzeDocument accepts single-page PDFs as bytes: split each scanned page out with pdf-lib. */
  private async syncPages(bytes: Uint8Array, pages: number[]) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const out = new Map<number, PdfLine[]>();
    for (const n of pages) {
      const one = await PDFDocument.create();
      const [copied] = await one.copyPages(src, [n - 1]);
      one.addPage(copied!);
      const h = copied!.getHeight();
      const res = await this.client.send(
        new AnalyzeDocumentCommand({
          Document: { Bytes: await one.save() },
          FeatureTypes: ['TABLES'],
        }),
      );
      out.set(n, textractLines(res.Blocks ?? [], h));
    }
    return out;
  }

  /** Multi-page: upload to S3, StartDocumentTextDetection, poll until done (max ~5 min). */
  private async asyncDocument(
    bytes: Uint8Array,
    pages: number[],
    opts: { tenantId?: string; filename?: string },
  ) {
    if (config().STORAGE_DRIVER !== 's3') throw new Error('async OCR requires STORAGE_DRIVER=s3');
    const key = storageKey(opts.tenantId ?? null, `ai-ocr/${opts.filename ?? 'document.pdf'}`);
    await storage().put(key, Buffer.from(bytes), 'application/pdf');
    try {
      const start = await this.client.send(
        new StartDocumentTextDetectionCommand({
          DocumentLocation: { S3Object: { Bucket: config().S3_BUCKET, Name: key } },
        }),
      );
      const jobId = start.JobId!;
      const blocks: Block[] = [];
      const deadline = Date.now() + 5 * 60_000;
      let delay = 1500;
      for (;;) {
        if (Date.now() > deadline) throw new Error('Textract job timed out');
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 10_000);
        let next: string | undefined;
        const first = await this.client.send(new GetDocumentTextDetectionCommand({ JobId: jobId }));
        if (first.JobStatus === 'IN_PROGRESS') continue;
        if (first.JobStatus !== 'SUCCEEDED' && first.JobStatus !== 'PARTIAL_SUCCESS')
          throw new Error(`Textract job ${first.JobStatus}: ${first.StatusMessage ?? ''}`);
        blocks.push(...(first.Blocks ?? []));
        next = first.NextToken;
        while (next) {
          const more = await this.client.send(
            new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: next }),
          );
          blocks.push(...(more.Blocks ?? []));
          next = more.NextToken;
        }
        break;
      }
      const wanted = new Set(pages);
      const byPage = new Map<number, Block[]>();
      for (const b of blocks) {
        const p = b.Page ?? 1;
        if (!wanted.has(p)) continue;
        byPage.set(p, [...(byPage.get(p) ?? []), b]);
      }
      return new Map([...byPage].map(([p, bs]) => [p, textractLines(bs)]));
    } finally {
      await storage()
        .remove(key)
        .catch(() => {});
    }
  }
}

let override: PdfTextExtractor | undefined;
let instance: PdfTextExtractor | undefined;

/** The configured extractor (OCR_PROVIDER). */
export const pdfText = (): PdfTextExtractor => {
  if (override) return override;
  instance ??= config().OCR_PROVIDER === 'textract' ? new TextractExtractor() : new LocalPdfText();
  return instance;
};

/** Tests only. */
export const setPdfText = (x: PdfTextExtractor | undefined) => {
  override = x;
};

/** Chunk pages into batches of at most `maxChars` characters for LLM prompts. */
export function pageBatches(pages: PdfPage[], maxChars = 12_000): PdfPage[][] {
  const batches: PdfPage[][] = [];
  let cur: PdfPage[] = [];
  let size = 0;
  for (const p of pages) {
    if (p.scanned) continue;
    const len = p.text.length + 40;
    if (cur.length && size + len > maxChars) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Render pages for an LLM prompt with explicit page markers. */
export const pagesForPrompt = (pages: PdfPage[], maxCharsPerPage = 12_000) =>
  pages.map((p) => `<page number="${p.page}">\n${p.text.slice(0, maxCharsPerPage)}\n</page>`).join('\n');
