import type { z } from '@procure/platform';
import type { ClaimData } from './data.js';
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
  section,
  text,
} from './pdf.js';

type Data = z.infer<typeof ClaimData>;
type Item = Data['items'][number];

export function claimDoc(d: Data, generatedAt = new Date()) {
  const c = d.claim;
  const chips: Chip[] = [];
  if (c.type) chips.push({ text: humanize(c.type), tone: 'red' });
  if (c.status)
    chips.push({
      text: humanize(c.status),
      tone: ['resolved', 'credited'].includes(c.status) ? 'green' : 'amber',
    });
  const content: Node[] = [
    letterhead(d.tenant, 'Freight / Product Claim', c.number, chips),
    blocks([
      block('Project', [
        d.project.name,
        ...(d.project.number ? [`Project ${d.project.number}`] : []),
        ...(d.project.propertyName ? [d.project.propertyName] : []),
        ...addressLines(d.project.address),
      ]),
      block('Vendor & order', [text(c.vendor), ...(c.poNumber ? [`PO ${c.poNumber}`] : [])]),
      block('Reported', [text(c.reportedBy), date(c.reportedAt)]),
    ]),
    ...notes('Description', c.description),
    section('Affected items'),
    dataTable(
      [
        { header: 'Code', width: 56, value: (i: Item) => text(i.code), strong: true },
        { header: 'Item', value: (i) => ({ text: i.name, color: C.ink }) },
        { header: 'Qty', width: 44, align: 'right', value: (i) => qty(i.qty) },
        { header: 'Note', width: 180, value: (i) => text(i.note) },
      ],
      d.items,
      { empty: 'No items listed' },
    ),
    {
      text: 'Photos and delivery receipts are attached to the claim in Pro-Cure. Please respond with a resolution (replacement, repair or credit) and expected ship date.',
      style: 'muted',
      margin: [0, 6, 0, 0],
    },
  ];
  return documentShell({
    title: 'Claim',
    subject: `Claim ${c.number} · ${d.project.name}`,
    tenantName: d.tenant.name,
    content,
    generatedAt,
  });
}
