import { PDFDocument, StandardFonts } from 'pdf-lib';

/** Build a multipart/form-data payload for app.inject. */
export function multipart(
  fields: Record<string, string | undefined>,
  file?: { filename: string; contentType: string; bytes: Buffer },
) {
  const boundary = `----procure${crypto.randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export async function samplePdf(pages: number, label = 'Vendor drawing') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`${label} — sheet ${i + 1}`, { x: 72, y: 700, size: 18, font });
  }
  return Buffer.from(await doc.save());
}

/** 1×1 transparent PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export const tenant = {
  name: 'JM Hospitality Solutions',
  address: { line1: '1 Commerce Way', city: 'Holly Springs', region: 'NC', postalCode: '27540' },
  phone: '(919) 555-0100',
  email: 'orders@jmhs.example',
};
export const project = {
  number: 'P-26-0007',
  name: 'Hampton Inn Raleigh Downtown — Renovation',
  propertyName: 'Hampton Inn Raleigh Downtown',
  address: '501 Fayetteville St\nRaleigh, NC 27601',
};

const poLines = [
  {
    code: 'GR-01',
    name: 'King Headboard',
    description: 'Upholstered panel',
    finish: 'Driftwood',
    qty: 120,
    unitCost: 245.5,
    extended: 29460,
  },
  { code: 'GR-02', name: 'Nightstand', finish: 'Driftwood', qty: 240, unitCost: 189, extended: 45360 },
  { code: 'GR-05', name: 'Desk Chair', qty: 120, unitCost: 210, extended: 25200 },
];
const purchaseOrder = {
  tenant,
  vendor: {
    name: 'Lakeshore Casegoods',
    address: { line1: '200 Mill St', city: 'Grand Rapids', region: 'MI', postalCode: '49503' },
    contact: { name: 'Dana Reps', email: 'dana@lakeshore.example', phone: '616-555-0199' },
  },
  po: {
    number: 'PO-26-0042',
    revision: 0,
    date: '2026-10-20',
    paymentTerms: '50% deposit, balance net 30',
    freightTerms: 'FOB origin',
    requestedDelivery: '2027-01-15',
    releaseBy: '2026-11-01',
    notes: 'Deliver to loading dock B. Call 24 hours ahead.',
    shipTo: {
      name: 'Hampton Inn Raleigh Downtown',
      line1: '501 Fayetteville St',
      city: 'Raleigh',
      region: 'NC',
      postalCode: '27601',
    },
    billTo: null,
    contact24h: { name: 'Site Superintendent', phone: '919-555-0123' },
  },
  project: { number: project.number, name: project.name },
  lines: poLines,
  totals: { subtotal: 100020, freight: 4800, tax: 0, total: 104820 },
  shipments: [
    {
      label: 'Shipment 1 — Floors 2–4',
      requestedDelivery: '2027-01-15',
      lines: [
        { code: 'GR-01', qty: 60 },
        { code: 'GR-02', qty: 120 },
      ],
    },
    {
      label: 'Shipment 2 — Floors 5–7',
      requestedDelivery: '2027-02-01',
      note: 'Hold for release',
      lines: [],
    },
  ],
};

export const SAMPLES = {
  quote: {
    tenant,
    project,
    client: { name: 'Lakeside Hospitality LLC', address: { line1: '9 Lake Rd', city: 'Cary', region: 'NC' } },
    quote: {
      number: 'Q-26-0011',
      name: 'Guestroom FF&E',
      date: '2026-10-01',
      validUntil: '2026-11-30',
      notes: 'Pricing excludes installation.',
    },
    contacts: [
      { role: 'project_manager', name: 'Pat Manager', email: 'pat@jmhs.example', phone: '919-555-0101' },
    ],
    sections: [
      {
        location: 'King Guestroom',
        lines: [
          {
            code: 'GR-01',
            name: 'King Headboard',
            description: 'Upholstered',
            finish: 'Driftwood',
            dimensions: '80"W',
            qty: 120,
            unit: 'ea',
            unitPrice: 325,
            extended: 39000,
          },
          { code: 'GR-02', name: 'Nightstand', qty: 240, unitPrice: '249.50', extended: 59880 },
        ],
      },
      { location: 'Lobby', lines: [{ code: 'PL-01', name: 'Lounge Chair', qty: 12, unitPrice: 890 }] },
    ],
    totals: { subtotal: 109560, freight: 5200, tax: 7669.2, total: 122429.2 },
  },
  purchase_order: purchaseOrder,
  po_revision: {
    ...purchaseOrder,
    po: { ...purchaseOrder.po, revision: 1, requestedDelivery: '2027-01-29' },
    lines: [...poLines, { code: 'GR-07', name: 'Luggage Bench', qty: 120, unitCost: 140, extended: 16800 }],
    totals: { subtotal: 116820, freight: 4800, tax: 0, total: 121620 },
    changes: [
      { field: 'requestedDelivery', from: '2027-01-15', to: '2027-01-29' },
      { field: 'qty', lineCode: 'GR-02', from: 220, to: 240 },
      { field: 'unitCost', lineCode: 'GR-01', from: 239, to: 245.5 },
      { field: 'added', lineCode: 'GR-07', to: 'Luggage Bench' },
      { field: 'removed', lineCode: 'GR-09', from: 'Valet Rod' },
    ],
  },
  schedule: {
    tenant,
    project,
    generatedAt: '2026-10-25T12:00:00Z',
    notes: 'Dates subject to owner approval of submittals.',
    headerFields: [
      { label: 'Target open', value: '2027-03-01' },
      { label: 'Rooms', value: 120 },
    ],
    milestones: [
      {
        name: 'Design approval',
        party: 'client',
        start: '2026-09-01',
        due: '2026-09-30',
        status: 'done',
        completedAt: '2026-09-28',
      },
      { name: 'Quote approval', party: 'client', due: '2026-10-15', status: 'in_progress' },
      { name: 'POs issued', party: 'internal', due: '2026-11-01', status: 'todo' },
      { name: 'Install', party: 'vendor', start: '2027-02-01', due: '2027-02-20' },
    ],
  },
  cost_request: {
    tenant,
    vendor: { name: 'Lakeshore Casegoods', contact: { name: 'Dana Reps', email: 'dana@lakeshore.example' } },
    project: { number: project.number, name: project.name },
    request: { number: 'CR-26-0003', dueDate: '2026-11-05', message: 'Please quote per attached drawings.' },
    lines: [
      {
        code: 'GR-01',
        name: 'King Headboard',
        description: 'Upholstered panel',
        finish: 'Driftwood',
        qty: 120,
      },
      { code: 'GR-02', name: 'Nightstand', qty: 240 },
    ],
  },
  invoice: {
    tenant,
    client: { name: 'Lakeside Hospitality LLC', address: '9 Lake Rd\nCary, NC 27511' },
    invoice: {
      number: 'INV-26-0019',
      kind: 'deposit',
      issueDate: '2026-10-22',
      dueDate: '2026-11-21',
      terms: 'Net 30',
      status: 'sent',
    },
    project: { number: project.number, name: project.name },
    lines: [
      {
        description: '50% deposit — Guestroom FF&E (Q-26-0011)',
        qty: 1,
        unitPrice: 61214.6,
        amount: 61214.6,
      },
    ],
    totals: { subtotal: 61214.6, tax: 0, total: 61214.6, paid: 10000, balance: 51214.6 },
    remitTo: 'JM Hospitality Solutions\nPO Box 100\nHolly Springs, NC 27540',
  },
  claim: {
    tenant,
    project,
    claim: {
      number: 'CL-26-0002',
      type: 'damage',
      status: 'open',
      description: 'Two headboards arrived with torn upholstery.',
      reportedBy: 'Site Manager',
      reportedAt: '2027-01-16T15:00:00Z',
      poNumber: 'PO-26-0042',
      vendor: 'Lakeshore Casegoods',
    },
    items: [{ code: 'GR-01', name: 'King Headboard', qty: 2, note: 'Torn fabric on corner' }],
  },
};

export const specBook = (documentIds: string[][]) => ({
  tenant,
  project,
  quote: { number: 'Q-26-0011', name: 'Guestroom FF&E' },
  date: '2026-10-25',
  specs: [
    {
      code: 'GR-01',
      name: 'King Headboard',
      category: 'casegoods',
      vendor: 'Lakeshore Casegoods',
      description: 'Upholstered wall-mounted panel headboard.',
      dimensions: '80"W x 2"D x 60"H',
      finish: 'Driftwood laminate',
      materials: 'MDF, polyurethane foam, vinyl',
      location: 'King Guestroom',
      documentIds: documentIds[0] ?? [],
    },
    {
      code: 'GR-02',
      name: 'Nightstand',
      category: 'casegoods',
      location: 'King Guestroom',
      documentIds: documentIds[1] ?? [],
    },
    {
      code: 'PL-01',
      name: 'Lounge Chair',
      category: 'soft_seating',
      location: 'Lobby',
      documentIds: documentIds[2] ?? [],
    },
  ],
});
