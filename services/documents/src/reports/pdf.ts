import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { formatUsd, round2 } from '@procure/domain';
import type * as PdfMakeModule from 'pdfmake';

type TDocumentDefinitions = Parameters<typeof PdfMakeModule.createPdf>[0];

/**
 * pdfmake 0.3 on Node: the package's CommonJS entry is a singleton (`require('pdfmake')`) configured
 * with font descriptors that point at real TTF files. We use the Roboto files bundled with pdfmake,
 * deny all remote URLs (templates never fetch images), and only allow local reads of those fonts.
 */
const require = createRequire(import.meta.url);
let engine: typeof PdfMakeModule | undefined;

const pdfmake = () => {
  if (engine) return engine;
  const pm = require('pdfmake') as typeof PdfMakeModule;
  const fontsFile = require.resolve('pdfmake/fonts/Roboto.js');
  const fontsDir = dirname(fontsFile);
  pm.setFonts(require(fontsFile));
  pm.setUrlAccessPolicy(() => false);
  pm.setLocalAccessPolicy((path: string) => path.startsWith(fontsDir));
  engine = pm;
  return pm;
};

/** Loosely-typed pdfmake node; the full union in @types/pdfmake is impractical to build against. */
// biome-ignore lint/suspicious/noExplicitAny: pdfmake document nodes are heterogeneous by design
export type Node = any;

export async function renderPdf(def: Record<string, unknown>): Promise<Buffer> {
  return pdfmake()
    .createPdf(def as unknown as TDocumentDefinitions)
    .getBuffer();
}

// ---------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------
export const C = {
  ink: '#1a1f36',
  body: '#3c4257',
  muted: '#697386',
  faint: '#a3acb9',
  border: '#e3e8ee',
  zebra: '#f7f9fc',
  headFill: '#f0f3f7',
  accent: '#4f46e5',
  accentSoft: '#eef2ff',
  amber: '#fff4d6',
  amberInk: '#92400e',
  amberBorder: '#f5c451',
  green: '#0e7a4f',
  greenSoft: '#e3f6ee',
  red: '#b42318',
  redSoft: '#fdecea',
};

export const PAGE_MARGINS: [number, number, number, number] = [44, 56, 44, 56];

export const styles = {
  h1: { fontSize: 20, bold: true, color: C.ink },
  h2: { fontSize: 12, bold: true, color: C.ink, margin: [0, 14, 0, 6] },
  h3: { fontSize: 10, bold: true, color: C.ink, margin: [0, 8, 0, 4] },
  label: { fontSize: 7, bold: true, color: C.muted, characterSpacing: 0.6 },
  muted: { fontSize: 8.5, color: C.muted },
  small: { fontSize: 8, color: C.body },
  th: { fontSize: 7.5, bold: true, color: C.muted, characterSpacing: 0.3 },
  td: { fontSize: 8.5, color: C.body },
  tdStrong: { fontSize: 8.5, color: C.ink, bold: true },
};

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------
export const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : formatUsd(round2(n));

export const qty = (n: number | null | undefined) =>
  n === null || n === undefined
    ? '—'
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-25' / ISO timestamp → 'Oct 25, 2026'. Unparseable input is returned unchanged. */
export const date = (v: string | null | undefined) => {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`;
};

export const dateTime = (d: Date) => `${date(d.toISOString())} ${d.toISOString().slice(11, 16)} UTC`;

export const text = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

export const humanize = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

/** Address may arrive as a preformatted string or an Address object. */
export const addressLines = (a: unknown): string[] => {
  if (!a) return [];
  if (typeof a === 'string')
    return a
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  if (typeof a !== 'object') return [String(a)];
  const o = a as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : '');
  const cityLine = [s('city'), [s('region'), s('postalCode')].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [
    s('name'),
    s('line1'),
    s('line2'),
    cityLine,
    s('country') && s('country') !== 'US' ? s('country') : '',
  ].filter(Boolean);
};

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------
export interface TenantInfo {
  name: string;
  address?: unknown;
  phone?: string | null;
  email?: string | null;
}

export interface Chip {
  text: string;
  tone?: 'neutral' | 'accent' | 'green' | 'amber' | 'red';
}

const TONES: Record<NonNullable<Chip['tone']>, [string, string]> = {
  neutral: [C.headFill, C.body],
  accent: [C.accentSoft, C.accent],
  green: [C.greenSoft, C.green],
  amber: [C.amber, C.amberInk],
  red: [C.redSoft, C.red],
};

export const chip = (c: Chip): Node => {
  const [fill, color] = TONES[c.tone ?? 'neutral'];
  return {
    table: {
      body: [[{ text: c.text.toUpperCase(), fontSize: 7, bold: true, color, characterSpacing: 0.5 }]],
    },
    layout: {
      fillColor: () => fill,
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 6,
      paddingRight: () => 6,
      paddingTop: () => 2.5,
      paddingBottom: () => 2,
    },
  };
};

/** First-page letterhead: firm on the left, document title + number on the right. */
export function letterhead(
  tenant: TenantInfo,
  title: string,
  number: string | null | undefined,
  chips: Chip[] = [],
): Node {
  const contact = [tenant.phone, tenant.email].filter(Boolean).join('  ·  ');
  return {
    stack: [
      {
        columns: [
          {
            width: '*',
            stack: [
              { text: tenant.name, fontSize: 13, bold: true, color: C.ink, margin: [0, 0, 0, 3] },
              ...addressLines(tenant.address).map((l) => ({ text: l, style: 'muted' })),
              ...(contact ? [{ text: contact, style: 'muted' }] : []),
            ],
          },
          {
            width: 'auto',
            alignment: 'right',
            stack: [
              { text: title, style: 'h1', alignment: 'right' },
              ...(number
                ? [{ text: number, fontSize: 10, color: C.muted, alignment: 'right', margin: [0, 2, 0, 0] }]
                : []),
              ...(chips.length
                ? [
                    {
                      columns: [
                        { width: '*', text: '' },
                        ...chips.map((c) => ({ width: 'auto', ...chip(c), margin: [6, 0, 0, 0] })),
                      ],
                      margin: [0, 6, 0, 0],
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      rule(14, 12),
    ],
  };
}

/** Usable width of a portrait LETTER page with PAGE_MARGINS. */
export const CONTENT_WIDTH = 612 - PAGE_MARGINS[0] - PAGE_MARGINS[2];

export const rule = (top = 8, bottom = 8, color = C.border): Node => ({
  canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.75, lineColor: color }],
  margin: [0, top, 0, bottom],
});

export const label = (t: string): Node => ({ text: t.toUpperCase(), style: 'label', margin: [0, 0, 0, 3] });

/** A labelled block of lines (Bill to / Ship to / Vendor ...). */
export const block = (title: string, lines: (string | Node)[], highlight = false): Node => {
  const content = {
    stack: [
      label(title),
      ...(lines.length ? lines : ['—']).map((l, i) =>
        typeof l === 'string'
          ? { text: l, fontSize: 8.5, color: i === 0 ? C.ink : C.body, bold: i === 0 }
          : l,
      ),
    ],
  };
  return highlight ? boxed(content, C.amber) : content;
};

const boxed = (content: Node, fill: string): Node => ({
  table: { widths: ['*'], body: [[content]] },
  layout: {
    fillColor: () => fill,
    hLineWidth: () => 0,
    vLineWidth: () => 0,
    paddingLeft: () => 6,
    paddingRight: () => 6,
    paddingTop: () => 4,
    paddingBottom: () => 4,
  },
});

/** Row of labelled blocks laid out as equal columns. */
export const blocks = (items: Node[], gap = 18): Node => ({
  columns: items.map((i) => ({ width: '*', ...i })),
  columnGap: gap,
  margin: [0, 0, 0, 10],
});

export interface Field {
  label: string;
  value: unknown;
  highlight?: boolean;
}

/** Grid of label/value pairs, `cols` per row. Highlighted fields get an amber background. */
export function fieldGrid(fields: Field[], cols = 4): Node {
  const cells: Node[] = fields.map((f) => ({
    stack: [label(f.label), { text: text(f.value), fontSize: 8.5, color: C.ink }],
    fillColor: f.highlight ? C.amber : undefined,
  }));
  while (cells.length % cols) cells.push({ text: '' });
  const body: Node[][] = [];
  for (let i = 0; i < cells.length; i += cols) body.push(cells.slice(i, i + cols));
  return {
    table: { widths: Array(cols).fill('*'), body },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: (i: number) => (i === 0 ? 0 : 6),
      paddingRight: () => 6,
      paddingTop: () => 4,
      paddingBottom: () => 5,
    },
    margin: [0, 0, 0, 8],
  };
}

export interface Column<R> {
  header: string;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  value: (row: R, index: number) => string | Node;
  strong?: boolean;
}

/**
 * Data table: light header band, zebra rows, hairline separators, right-aligned numbers. `highlight`
 * marks rows (e.g. changed PO lines) with an amber fill. Header repeats on page breaks.
 */
export function dataTable<R>(
  columns: Column<R>[],
  rows: R[],
  opts: { highlight?: (r: R) => boolean; empty?: string } = {},
): Node {
  const header = columns.map((c) => ({
    text: c.header.toUpperCase(),
    style: 'th',
    alignment: c.align ?? 'left',
  }));
  const body = rows.map((r, i) =>
    columns.map((c) => {
      const v = c.value(r, i);
      const cell = typeof v === 'string' ? { text: v } : v;
      return { style: c.strong ? 'tdStrong' : 'td', alignment: c.align ?? 'left', ...cell };
    }),
  );
  if (!body.length)
    body.push([
      { text: opts.empty ?? 'No items', style: 'muted', italics: true, colSpan: columns.length },
      ...columns.slice(1).map(() => ({})),
    ]);
  const highlighted = new Set(rows.map((r, i) => (opts.highlight?.(r) ? i + 1 : -1)));
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: columns.map((c) => c.width ?? '*'),
      body: [header, ...body],
    },
    layout: {
      fillColor: (row: number) =>
        row === 0 ? C.headFill : highlighted.has(row) ? C.amber : row % 2 === 0 ? C.zebra : null,
      hLineWidth: (i: number, node: Node) =>
        i === 0 || i === node.table.body.length ? 0 : i === 1 ? 0.75 : 0.4,
      hLineColor: () => C.border,
      vLineWidth: () => 0,
      paddingLeft: (i: number) => (i === 0 ? 6 : 5),
      paddingRight: (i: number, node: Node) => (i === node.table.widths.length - 1 ? 6 : 5),
      paddingTop: () => 5,
      paddingBottom: () => 5,
    },
    margin: [0, 0, 0, 10],
  };
}

export interface TotalLine {
  label: string;
  value: number | null | undefined;
  emphasis?: boolean;
}

/** Right-aligned totals block. */
export function totals(lines: TotalLine[]): Node {
  const body = lines.map((l) => [
    {
      text: l.label,
      fontSize: l.emphasis ? 10 : 8.5,
      bold: !!l.emphasis,
      color: l.emphasis ? C.ink : C.muted,
    },
    {
      text: usd(l.value),
      fontSize: l.emphasis ? 10 : 8.5,
      bold: !!l.emphasis,
      color: C.ink,
      alignment: 'right',
    },
  ]);
  return {
    columns: [
      { width: '*', text: '' },
      {
        width: 220,
        table: { widths: ['*', 'auto'], body },
        layout: {
          hLineWidth: (i: number) => (i === lines.findIndex((l) => l.emphasis) && i > 0 ? 0.75 : 0),
          hLineColor: () => C.ink,
          vLineWidth: () => 0,
          paddingLeft: () => 0,
          paddingRight: () => 6,
          paddingTop: (i: number) => (lines[i]?.emphasis ? 6 : 2),
          paddingBottom: () => 2,
        },
      },
    ],
    margin: [0, 2, 0, 12],
  };
}

export const section = (title: string): Node => ({ text: title, style: 'h2' });

/** Heading + paragraph kept together so the heading never orphans at a page bottom. */
export const notes = (title: string, body: string | null | undefined): Node[] =>
  body
    ? [
        {
          unbreakable: true,
          stack: [section(title), { text: body, fontSize: 8.5, color: C.body, lineHeight: 1.3 }],
        },
      ]
    : [];

/** Standard document shell: running header after page 1, footer with generated time + page x of y. */
export function documentShell(opts: {
  title: string;
  subject: string;
  tenantName: string;
  content: Node[];
  generatedAt?: Date;
  footerNumbers?: boolean;
}): Record<string, unknown> {
  const generated = opts.generatedAt ?? new Date();
  return {
    pageSize: 'LETTER',
    pageOrientation: 'portrait',
    pageMargins: PAGE_MARGINS,
    info: {
      title: opts.subject,
      author: opts.tenantName,
      subject: opts.title,
      creator: 'Pro-Cure',
      producer: 'Pro-Cure',
    },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: C.body, lineHeight: 1.15 },
    styles,
    header: (page: number) =>
      page === 1
        ? null
        : {
            columns: [
              { text: opts.tenantName, fontSize: 7.5, color: C.muted, bold: true },
              { text: opts.subject, fontSize: 7.5, color: C.muted, alignment: 'right' },
            ],
            margin: [PAGE_MARGINS[0], 24, PAGE_MARGINS[2], 0],
          },
    footer:
      opts.footerNumbers === false
        ? undefined
        : (page: number, pages: number) => ({
            columns: [
              { text: `Generated ${dateTime(generated)} · Pro-Cure`, fontSize: 7, color: C.faint },
              { text: `Page ${page} of ${pages}`, fontSize: 7, color: C.muted, alignment: 'right' },
            ],
            margin: [PAGE_MARGINS[0], 20, PAGE_MARGINS[2], 0],
          }),
    content: opts.content,
  };
}
