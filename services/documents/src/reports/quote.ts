import { sum } from '@procure/domain';
import type { z } from '@procure/platform';
import type { QuoteData } from './data.js';
import {
  addressLines,
  block,
  blocks,
  C,
  dataTable,
  date,
  documentShell,
  humanize,
  letterhead,
  type Node,
  notes,
  qty,
  section,
  text,
  totals,
  usd,
} from './pdf.js';

type Data = z.infer<typeof QuoteData>;
type Line = Data['sections'][number]['lines'][number];

const detail = (l: Line): Node => ({
  stack: [
    { text: l.name, bold: true, color: C.ink },
    ...(l.description ? [{ text: l.description, fontSize: 7.5, color: C.muted }] : []),
    ...([l.finish && `Finish: ${l.finish}`, l.dimensions && `Size: ${l.dimensions}`].filter(Boolean).length
      ? [
          {
            text: [l.finish && `Finish: ${l.finish}`, l.dimensions && `Size: ${l.dimensions}`]
              .filter(Boolean)
              .join('   ·   '),
            fontSize: 7.5,
            color: C.muted,
          },
        ]
      : []),
  ],
});

export function quoteDoc(d: Data, generatedAt = new Date()) {
  const q = d.quote;
  const content: Node[] = [
    letterhead(d.tenant, 'Quote', q.number, q.status ? [{ text: humanize(q.status), tone: 'accent' }] : []),
    blocks([
      block('Project', [
        d.project.name,
        ...(d.project.number ? [`Project ${d.project.number}`] : []),
        ...(d.project.propertyName ? [d.project.propertyName] : []),
        ...addressLines(d.project.address),
      ]),
      block('Prepared for', d.client?.name ? [d.client.name, ...addressLines(d.client.address)] : ['—']),
      block('Quote', [q.name ?? q.number, `Date: ${date(q.date)}`, `Valid until: ${date(q.validUntil)}`]),
    ]),
  ];

  if (d.contacts.length) {
    content.push(
      section('Your project team'),
      dataTable(
        [
          { header: 'Role', width: 110, value: (c) => humanize(text(c.role)) },
          { header: 'Name', value: (c) => c.name, strong: true },
          { header: 'Email', value: (c) => text(c.email) },
          { header: 'Phone', width: 90, value: (c) => text(c.phone) },
        ],
        d.contacts,
      ),
    );
  }

  for (const s of d.sections) {
    const subtotal = sum(s.lines.map((l) => l.extended ?? (l.unitPrice ?? 0) * l.qty));
    content.push(
      { text: s.location, style: 'h2' },
      dataTable(
        [
          { header: 'Code', width: 46, value: (l) => text(l.code), strong: true },
          { header: 'Item', value: (l) => detail(l) },
          { header: 'Qty', width: 40, align: 'right', value: (l) => qty(l.qty) },
          { header: 'Unit', width: 34, value: (l) => text(l.unit ?? 'ea') },
          { header: 'Unit price', width: 66, align: 'right', value: (l) => usd(l.unitPrice) },
          {
            header: 'Extended',
            width: 72,
            align: 'right',
            strong: true,
            value: (l) => usd(l.extended ?? (l.unitPrice ?? 0) * l.qty),
          },
        ],
        s.lines,
      ),
      {
        text: [
          { text: `${s.location} subtotal  `, color: C.muted },
          { text: usd(subtotal), bold: true, color: C.ink },
        ],
        alignment: 'right',
        fontSize: 8.5,
        margin: [0, -4, 6, 6],
      },
    );
  }

  content.push(
    totals([
      { label: 'Subtotal', value: d.totals.subtotal },
      ...(d.totals.freight !== null && d.totals.freight !== undefined
        ? [{ label: 'Freight & handling', value: d.totals.freight }]
        : []),
      ...(d.totals.tax !== null && d.totals.tax !== undefined ? [{ label: 'Tax', value: d.totals.tax }] : []),
      { label: 'Total', value: d.totals.total, emphasis: true },
    ]),
    ...notes('Notes', q.notes),
    ...notes(
      'Terms',
      d.terms ??
        'Prices are valid until the date shown. Freight and tax are estimates and will be invoiced as incurred.',
    ),
    {
      margin: [0, 24, 0, 0],
      columns: [
        {
          width: '*',
          stack: [
            { text: ' ', margin: [0, 18, 0, 0] },
            { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 220, y2: 0, lineWidth: 0.75, lineColor: C.faint }] },
            { text: 'Approved by (signature, name, date)', style: 'muted', margin: [0, 3, 0, 0] },
          ],
        },
        { width: '*', text: '' },
      ],
      unbreakable: true,
    },
  );

  return documentShell({
    title: 'Quote',
    subject: `Quote ${q.number} · ${d.project.name}`,
    tenantName: d.tenant.name,
    content,
    generatedAt,
  });
}
