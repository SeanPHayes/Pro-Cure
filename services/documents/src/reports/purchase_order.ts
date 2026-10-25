import type { z } from '@procure/platform';
import type { Change, PurchaseOrderData } from './data.js';
import {
  addressLines,
  block,
  blocks,
  C,
  type Chip,
  dataTable,
  date,
  documentShell,
  type Field,
  fieldGrid,
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

type Data = z.infer<typeof PurchaseOrderData>;
type Line = Data['lines'][number];

const MONEY_FIELDS = new Set(['unitCost', 'extended', 'unit_cost', 'total', 'subtotal', 'freight', 'tax']);
const DATE_FIELDS = new Set(['requestedDelivery', 'releaseBy', 'date', 'shipDate', 'requested_delivery']);

/** Render a changed value the way the field is shown elsewhere on the document. */
export const fmtValue = (field: string, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (MONEY_FIELDS.has(field) && (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v))))
    return usd(Number(v));
  if (DATE_FIELDS.has(field) && typeof v === 'string') return date(v);
  if (typeof v === 'object') return addressLines(v).join(', ') || JSON.stringify(v);
  return String(v);
};

const isLineAdded = (c: Change) => ['added', 'line_added', 'add'].includes(c.field);
const isLineRemoved = (c: Change) => ['removed', 'line_removed', 'remove', 'deleted'].includes(c.field);

/** Shared by purchase_order and po_revision; `revision` turns on change highlighting. */
export function purchaseOrderDoc(d: Data, opts: { revision: boolean }, generatedAt = new Date()) {
  const po = d.po;
  const changes = opts.revision ? d.changes : [];
  const headerChanges = new Map<string, Change>();
  const lineChanges = new Map<string, Change[]>();
  for (const c of changes) {
    if (c.lineCode) lineChanges.set(c.lineCode, [...(lineChanges.get(c.lineCode) ?? []), c]);
    else headerChanges.set(c.field, c);
  }
  const changed = (field: string) => headerChanges.has(field);
  const removedLines = changes.filter((c) => c.lineCode && isLineRemoved(c));

  const chips: Chip[] = [];
  if (po.revision > 0)
    chips.push({ text: `Revision ${po.revision}`, tone: opts.revision ? 'amber' : 'neutral' });
  const title = opts.revision ? 'Purchase Order Revision' : 'Purchase Order';
  const number = po.revision > 0 ? `${po.number} · Rev ${po.revision}` : po.number;

  const contact24h =
    typeof po.contact24h === 'string'
      ? [po.contact24h]
      : po.contact24h
        ? [po.contact24h.name, po.contact24h.phone, po.contact24h.email].filter((x): x is string => !!x)
        : [];
  const vc = d.vendor.contact;

  const content: Node[] = [letterhead(d.tenant, title, number, chips)];

  if (opts.revision) {
    content.push({
      table: {
        widths: ['*'],
        body: [
          [
            {
              stack: [
                {
                  text: `This revision supersedes all previous versions of ${po.number}.`,
                  bold: true,
                  color: C.amberInk,
                  fontSize: 9,
                },
                {
                  text: `${changes.length} change${changes.length === 1 ? '' : 's'} highlighted below. Please acknowledge the revised order.`,
                  color: C.amberInk,
                  fontSize: 8.5,
                },
              ],
            },
          ],
        ],
      },
      layout: {
        fillColor: () => C.amber,
        hLineWidth: () => 0,
        vLineWidth: (i: number) => (i === 0 ? 3 : 0),
        vLineColor: () => C.amberBorder,
        paddingLeft: () => 10,
        paddingTop: () => 7,
        paddingBottom: () => 7,
      },
      margin: [0, 0, 0, 12],
    });
  }

  content.push(
    blocks([
      block('Vendor', [
        d.vendor.name,
        ...addressLines(d.vendor.address),
        ...(vc ? [[vc.name, vc.email, vc.phone].filter(Boolean).join(' · ')].filter(Boolean) : []),
      ]),
      block('Ship to', addressLines(po.shipTo), changed('shipTo')),
      block(
        'Bill to',
        addressLines(po.billTo).length
          ? addressLines(po.billTo)
          : [d.tenant.name, ...addressLines(d.tenant.address)],
        changed('billTo'),
      ),
    ]),
    fieldGrid(
      (
        [
          { label: 'PO date', value: date(po.date), key: 'date' },
          {
            label: 'Project',
            value: [d.project.number, d.project.name].filter(Boolean).join(' · '),
            key: 'project',
          },
          { label: 'Requested delivery', value: date(po.requestedDelivery), key: 'requestedDelivery' },
          { label: 'Release by', value: date(po.releaseBy), key: 'releaseBy' },
          { label: 'Payment terms', value: po.paymentTerms, key: 'paymentTerms' },
          { label: 'Freight terms', value: po.freightTerms, key: 'freightTerms' },
          { label: '24-hour delivery contact', value: contact24h.join(' · ') || null, key: 'contact24h' },
          { label: 'Revision', value: String(po.revision), key: 'revision' },
        ] as (Field & { key: string })[]
      ).map((f) => ({ ...f, highlight: changed(f.key) })),
    ),
  );

  if (opts.revision) {
    content.push(
      section('Revision summary'),
      dataTable(
        [
          { header: 'Line', width: 56, value: (c: Change) => text(c.lineCode ?? 'Header'), strong: true },
          { header: 'Field', width: 110, value: (c) => humanize(c.field) },
          {
            header: 'From',
            value: (c) => ({ text: fmtValue(c.field, c.from), color: C.muted, decoration: 'lineThrough' }),
          },
          { header: 'To', value: (c) => ({ text: fmtValue(c.field, c.to), bold: true, color: C.ink }) },
        ],
        changes,
        { highlight: () => true },
      ),
    );
  }

  const changeCell = (l: Line): Node => {
    const cs = lineChanges.get(l.code) ?? [];
    if (!cs.length) return { text: '' };
    return {
      stack: cs.map((c) =>
        isLineAdded(c)
          ? { text: 'New line', bold: true, color: C.amberInk, fontSize: 7.5 }
          : {
              text: [
                { text: `${humanize(c.field)}: `, bold: true, color: C.amberInk },
                { text: fmtValue(c.field, c.from), decoration: 'lineThrough', color: C.muted },
                { text: '  »  ', color: C.amberInk },
                { text: fmtValue(c.field, c.to), bold: true, color: C.ink },
              ],
              fontSize: 7.5,
            },
      ),
    };
  };

  const lineDetail = (l: Line): Node => ({
    stack: [
      { text: l.name, bold: true, color: C.ink },
      ...(l.description ? [{ text: l.description, fontSize: 7.5, color: C.muted }] : []),
      ...(l.finish ? [{ text: `Finish: ${l.finish}`, fontSize: 7.5, color: C.muted }] : []),
    ],
  });

  content.push(
    section('Order lines'),
    dataTable(
      [
        { header: 'Code', width: 46, value: (l: Line) => l.code, strong: true },
        { header: 'Item', value: lineDetail },
        { header: 'Qty', width: 36, align: 'right', value: (l) => qty(l.qty) },
        { header: 'Unit cost', width: 62, align: 'right', value: (l) => usd(l.unitCost) },
        {
          header: 'Extended',
          width: 68,
          align: 'right',
          strong: true,
          value: (l) => usd(l.extended ?? (l.unitCost ?? 0) * l.qty),
        },
        ...(opts.revision ? [{ header: 'Changed', width: 128, value: changeCell }] : []),
      ],
      d.lines,
      { highlight: (l) => lineChanges.has(l.code) },
    ),
  );

  if (removedLines.length) {
    content.push(
      { text: 'Removed lines', style: 'h3' },
      dataTable(
        [
          {
            header: 'Code',
            width: 56,
            value: (c: Change) => ({ text: text(c.lineCode), decoration: 'lineThrough' }),
          },
          {
            header: 'Removed item',
            value: (c) => ({ text: fmtValue('item', c.from), decoration: 'lineThrough', color: C.muted }),
          },
        ],
        removedLines,
        { highlight: () => true },
      ),
    );
  }

  content.push(
    totals([
      { label: 'Subtotal', value: d.totals.subtotal },
      ...(d.totals.freight !== null && d.totals.freight !== undefined
        ? [{ label: 'Freight', value: d.totals.freight }]
        : []),
      ...(d.totals.tax !== null && d.totals.tax !== undefined ? [{ label: 'Tax', value: d.totals.tax }] : []),
      { label: 'PO total', value: d.totals.total, emphasis: true },
    ]),
  );

  if (d.shipments.length) {
    content.push(section('Shipments'));
    for (const s of d.shipments) {
      content.push({
        unbreakable: true,
        stack: [
          {
            columns: [
              { text: s.label, bold: true, color: C.ink, fontSize: 9, width: '*' },
              {
                text: `Requested delivery ${date(s.requestedDelivery)}`,
                style: 'muted',
                alignment: 'right',
                width: 'auto',
              },
            ],
            margin: [0, 2, 0, 3],
          },
          ...(s.note ? [{ text: s.note, style: 'muted', margin: [0, 0, 0, 4] }] : []),
          dataTable(
            [
              {
                header: 'Code',
                width: 80,
                value: (r: { code: string; qty: number }) => r.code,
                strong: true,
              },
              {
                header: 'Item',
                value: (r) => text(d.lines.find((l) => l.code === r.code)?.name),
              },
              { header: 'Qty', width: 50, align: 'right', value: (r) => qty(r.qty) },
            ],
            s.lines,
            { empty: 'All lines' },
          ),
        ],
      });
    }
  }

  content.push(
    ...notes('Notes & instructions', po.notes),
    ...notes(
      'Acknowledgement',
      `Please confirm receipt of this ${opts.revision ? 'revised ' : ''}purchase order, pricing, and ship date within 2 business days. Reference ${po.number} on all correspondence, packing lists, bills of lading and invoices.`,
    ),
  );

  return documentShell({
    title,
    subject: `${opts.revision ? 'PO revision' : 'PO'} ${number} · ${d.vendor.name}`,
    tenantName: d.tenant.name,
    content,
    generatedAt,
  });
}
