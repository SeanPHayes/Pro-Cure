import type { z } from '@procure/platform';
import type { CostRequestData } from './data.js';
import {
  addressLines,
  block,
  blocks,
  C,
  dataTable,
  date,
  documentShell,
  letterhead,
  type Node,
  notes,
  qty,
  section,
  text,
} from './pdf.js';

type Data = z.infer<typeof CostRequestData>;
type Line = Data['lines'][number];

/** Request for pricing sent to a vendor. Deliberately carries no internal cost, sell price or margin. */
export function costRequestDoc(d: Data, generatedAt = new Date()) {
  const r = d.request;
  const vc = d.vendor.contact;
  const content: Node[] = [
    letterhead(
      d.tenant,
      'Request for Pricing',
      r.number,
      r.dueDate ? [{ text: `Due ${date(r.dueDate)}`, tone: 'amber' }] : [],
    ),
    blocks([
      block('Vendor', [
        d.vendor.name,
        ...addressLines(d.vendor.address),
        ...(vc ? [[vc.name, vc.email, vc.phone].filter(Boolean).join(' · ')].filter(Boolean) : []),
      ]),
      block(
        'Project',
        d.project?.name
          ? [d.project.name, ...(d.project.number ? [`Project ${d.project.number}`] : [])]
          : ['—'],
      ),
      block('Request', [
        r.number,
        `Issued: ${date(r.date ?? generatedAt.toISOString())}`,
        `Response due: ${date(r.dueDate)}`,
      ]),
    ]),
    ...notes('Message', r.message),
    section('Items to price'),
    dataTable(
      [
        { header: 'Code', width: 50, value: (l: Line) => l.code, strong: true },
        {
          header: 'Item',
          value: (l) => ({
            stack: [
              { text: l.name, bold: true, color: C.ink },
              ...(l.description ? [{ text: l.description, fontSize: 7.5, color: C.muted }] : []),
              ...([l.finish && `Finish: ${l.finish}`, l.dimensions && `Size: ${l.dimensions}`].filter(Boolean)
                .length
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
          }),
        },
        { header: 'Qty', width: 40, align: 'right', value: (l) => qty(l.qty) },
        { header: 'Unit cost', width: 70, align: 'right', value: () => ({ text: ' ' }) },
        { header: 'Lead time (wks)', width: 62, align: 'right', value: () => ({ text: ' ' }) },
      ],
      d.lines,
    ),
    {
      text: [
        { text: 'How to respond: ', bold: true, color: C.ink },
        `Reply through the Pro-Cure vendor portal or return this form with unit cost, lead time, freight terms and quote validity for each line. Reference ${text(r.number)}.`,
      ],
      fontSize: 8.5,
      margin: [0, 6, 0, 0],
    },
  ];
  return documentShell({
    title: 'Request for Pricing',
    subject: `Cost request ${r.number} · ${d.vendor.name}`,
    tenantName: d.tenant.name,
    content,
    generatedAt,
  });
}
