import type { z } from '@procure/platform';
import type { InvoiceData } from './data.js';
import {
  addressLines,
  block,
  blocks,
  C,
  type Chip,
  dataTable,
  date,
  documentShell,
  humanize,
  letterhead,
  type Node,
  notes,
  qty,
  text,
  totals,
  usd,
} from './pdf.js';

type Data = z.infer<typeof InvoiceData>;
type Line = Data['lines'][number];

export function invoiceDoc(d: Data, generatedAt = new Date()) {
  const inv = d.invoice;
  const t = d.totals;
  const balance = t.balance ?? (t.paid !== null && t.paid !== undefined ? t.total - t.paid : t.total);
  const chips: Chip[] = [];
  if (inv.kind) chips.push({ text: humanize(inv.kind), tone: 'accent' });
  if (inv.status)
    chips.push({
      text: humanize(inv.status),
      tone: inv.status === 'paid' ? 'green' : inv.status === 'overdue' ? 'red' : 'neutral',
    });
  const title = inv.kind === 'credit_memo' ? 'Credit Memo' : 'Invoice';

  const remit = typeof d.remitTo === 'string' ? d.remitTo.split('\n') : addressLines(d.remitTo);

  const content: Node[] = [
    letterhead(d.tenant, title, inv.number, chips),
    {
      columns: [
        {
          width: '*',
          stack: [
            {
              text: `${usd(balance)} due ${inv.dueDate ? date(inv.dueDate) : 'on receipt'}`,
              fontSize: 16,
              bold: true,
              color: C.ink,
            },
            ...(d.project?.name
              ? [
                  {
                    text: [d.project.number, d.project.name].filter(Boolean).join(' · '),
                    style: 'muted',
                    margin: [0, 2, 0, 0],
                  },
                ]
              : []),
          ],
        },
      ],
      margin: [0, 0, 0, 12],
    },
    blocks([
      block('Bill to', [d.client.name, ...addressLines(d.client.address)]),
      block('Details', [
        `Invoice ${inv.number}`,
        `Issued: ${date(inv.issueDate)}`,
        `Due: ${date(inv.dueDate)}`,
        ...(inv.terms ? [`Terms: ${inv.terms}`] : []),
      ]),
      block('Remit to', remit.length ? remit : [d.tenant.name, ...addressLines(d.tenant.address)]),
    ]),
    dataTable(
      [
        { header: 'Description', value: (l: Line) => ({ text: l.description, color: C.ink }) },
        { header: 'Qty', width: 44, align: 'right', value: (l) => qty(l.qty) },
        { header: 'Unit price', width: 76, align: 'right', value: (l) => usd(l.unitPrice) },
        { header: 'Amount', width: 80, align: 'right', strong: true, value: (l) => usd(l.amount) },
      ],
      d.lines,
    ),
    totals([
      { label: 'Subtotal', value: t.subtotal },
      ...(t.tax !== null && t.tax !== undefined ? [{ label: 'Tax', value: t.tax }] : []),
      { label: 'Total', value: t.total },
      ...(t.paid ? [{ label: 'Paid to date', value: -t.paid }] : []),
      { label: 'Balance due', value: balance, emphasis: true },
    ]),
    ...notes('Notes', inv.notes),
    {
      text: `Please reference ${text(inv.number)} with your payment. Thank you for your business.`,
      style: 'muted',
      margin: [0, 12, 0, 0],
    },
  ];
  return documentShell({
    title,
    subject: `${title} ${inv.number} · ${d.client.name}`,
    tenantName: d.tenant.name,
    content,
    generatedAt,
  });
}
