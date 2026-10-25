import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';

/** Fixture PDFs drawn with pdf-lib so the real pdfjs text pipeline is exercised. */

interface Pen {
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  y: number;
}

const line = (
  pen: Pen,
  text: string,
  opts: { x?: number; size?: number; bold?: boolean; gap?: number } = {},
) => {
  const size = opts.size ?? 10;
  pen.page.drawText(text, { x: opts.x ?? 54, y: pen.y, size, font: opts.bold ? pen.bold : pen.font });
  pen.y -= opts.gap ?? size + 5;
};

const row = (pen: Pen, cells: [number, string][], size = 9) => {
  for (const [x, t] of cells) pen.page.drawText(t, { x, y: pen.y, size, font: pen.font });
  pen.y -= size + 6;
};

async function newDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, font, bold };
}

const footer = (pen: Pen, n: number, total: number, text: string) => {
  pen.page.drawText(`${text}   Page ${n} of ${total}`, { x: 54, y: 30, size: 7, font: pen.font });
};

// ---------------------------------------------------------------- brand standard
export async function brandStandardPdf(): Promise<Uint8Array> {
  const { doc, font, bold } = await newDoc();
  const FOOT = 'Hampton by Hilton – Confidential & Proprietary';
  const pages: ((pen: Pen) => void)[] = [
    (pen) => {
      line(pen, 'Hampton by Hilton', { size: 20, bold: true, gap: 28 });
      line(pen, 'Guestroom & Public Space FF&E Design Standards', { size: 14, bold: true, gap: 20 });
      line(pen, 'Version 4.2', { size: 11 });
      line(pen, 'Effective Date: March 1, 2026', { size: 11, gap: 30 });
      line(pen, 'GUESTROOM', { size: 13, bold: true, gap: 20 });
      line(pen, 'CG-101  King Headboard', { bold: true });
      line(pen, 'Dimensions: 80"W x 3"D x 54"H');
      line(pen, 'Finish: Hampton Walnut HW-22 thermofoil, matte');
      line(pen, 'Material(s): MDF core, high-pressure laminate edges');
      line(pen, 'Approved Manufacturer(s): Formacase (Model HB-8054); Pacific Coast Furniture');
      line(pen, 'Qty: 1 per king guestroom', { gap: 20 });
      line(pen, 'CG-102  Nightstand, 2 Drawer', { bold: true });
      line(pen, 'Dimensions: 24"W x 18"D x 26"H');
      line(pen, 'Finish: Hampton Walnut HW-22');
      line(pen, 'Approved Manufacturer(s): Formacase (Model NS-2418)');
      line(pen, 'Qty: 2 per double queen, 1 per king', { gap: 20 });
      line(pen, 'ST-12  Desk Chair', { bold: true });
      line(pen, 'Dimensions: 22"W x 23"D x 33"H, SH 18"');
      line(pen, 'Material(s): Molded polypropylene shell, upholstered seat');
      line(pen, 'Finish: Black powdercoat base');
      line(pen, 'Approved Manufacturer(s): Kimball Hospitality – Model KH-350 or approved equal');
      line(pen, 'Qty: 1 per guestroom');
    },
    (pen) => {
      line(pen, 'GUESTROOM (continued)', { size: 9 });
      pen.y -= 6;
      line(pen, 'LT-3  Bedside Wall Sconce', { bold: true });
      line(pen, 'Dimensions: 6"W x 9"D x 12"H');
      line(pen, 'Finish: Brushed nickel with white linen shade');
      line(pen, 'Approved Manufacturer(s): Lightco Inc. (Style LS-301)');
      line(pen, 'Qty: 2 per king', { gap: 20 });
      line(pen, 'MR-01  Vanity Mirror', { bold: true });
      line(pen, 'Dimensions: 30"W x 42"H');
      line(pen, 'Description: Frameless, polished edge, LED backlit with defogger');
      line(pen, 'Qty: 1 per bathroom', { gap: 26 });
      line(pen, 'PUBLIC AREAS – LOBBY', { size: 13, bold: true, gap: 20 });
      line(pen, 'FF-04A  Lobby Lounge Chair', { bold: true });
      line(pen, 'Dimensions: 30"W x 32"D x 31"H');
      line(pen, 'Material(s): Hardwood frame, COM upholstery, 50,000 double rubs');
      line(pen, 'Approved Manufacturer(s): Sunrise Seating; Kimball Hospitality');
      line(pen, 'Qty: per plan', { gap: 20 });
      line(pen, 'CP-2  Corridor Broadloom Carpet', { bold: true });
      line(pen, 'Material(s): Solution-dyed nylon, 28 oz');
      line(pen, 'Approved Manufacturer(s): Shaw Hospitality (Style Wanderlust)');
      line(pen, 'Qty: per plan');
    },
  ];
  for (const [i, draw] of pages.entries()) {
    const page = doc.addPage([612, 792]);
    const pen = { page, font, bold, y: 740 };
    draw(pen);
    footer(pen, i + 1, pages.length, FOOT);
  }
  return doc.save();
}

// ---------------------------------------------------------------- vendor quote
export async function vendorQuotePdf(): Promise<Uint8Array> {
  const { doc, font, bold } = await newDoc();
  const page = doc.addPage([612, 792]);
  const pen: Pen = { page, font, bold, y: 750 };
  line(pen, 'Formacase Furniture Manufacturing, Inc.', { size: 14, bold: true, gap: 18 });
  line(pen, '1200 Industrial Pkwy, Hickory NC 28601   (828) 555-0142', { size: 8, gap: 22 });
  line(pen, 'QUOTATION', { size: 16, bold: true, gap: 22 });
  line(pen, 'Quote No: FQ-55821');
  line(pen, 'Quote Date: 10/15/2026');
  line(pen, 'Valid Until: 12/31/2026');
  line(pen, 'Lead Time: 10-12 weeks from approved drawings');
  line(pen, 'Freight Terms: FOB Factory, freight prepaid & add', { gap: 22 });
  line(pen, 'Quote To: JM Hospitality Solutions – Hampton Inn Raleigh Renovation', { gap: 24 });
  row(pen, [
    [54, 'Item'],
    [96, 'Model'],
    [170, 'Description'],
    [400, 'Qty'],
    [450, 'Unit Price'],
    [530, 'Extended'],
  ]);
  row(pen, [
    [54, '1'],
    [96, 'HB-8054'],
    [170, 'King Headboard CG-101, HW-22'],
    [400, '120'],
    [450, '$425.00'],
    [530, '$51,000.00'],
  ]);
  row(pen, [
    [54, '2'],
    [96, 'NS-2418'],
    [170, 'Nightstand 2 drawer walnut'],
    [400, '200'],
    [450, '$198.50'],
    [530, '$39,700.00'],
  ]);
  row(pen, [
    [54, '3'],
    [96, 'DK-4824'],
    [170, 'Work Desk with power grommet'],
    [400, '120'],
    [450, '$1,150.00'],
    [530, '$138,000.00'],
  ]);
  line(pen, '      Finish: HW-22 thermofoil; lead time 14 weeks', { x: 170, size: 8 });
  row(pen, [
    [54, '4'],
    [96, 'LG-3020'],
    [170, 'Luggage bench, upholstered'],
    [400, '115'],
    [450, '$310.00'],
    [530, '$35,650.00'],
  ]);
  pen.y -= 10;
  row(pen, [
    [400, 'Subtotal'],
    [530, '$264,350.00'],
  ]);
  row(pen, [
    [400, 'Freight'],
    [530, '$8,400.00'],
  ]);
  row(pen, [
    [400, 'Total'],
    [530, '$272,750.00'],
  ]);
  pen.y -= 16;
  line(pen, 'Prices valid for 75 days. 50% deposit required with order.', { size: 8 });
  return doc.save();
}

// ---------------------------------------------------------------- drawing packet (6 pages, 3 specs)
export async function drawingPacketPdf(): Promise<Uint8Array> {
  const { doc, font, bold } = await newDoc();
  const titleBlock = (
    page: PDFPage,
    item: string | null,
    model: string | null,
    title: string,
    sheet: string,
  ) => {
    page.drawRectangle({ x: 36, y: 36, width: 720, height: 70, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    page.drawText('Formacase Furniture Manufacturing', { x: 46, y: 88, size: 9, font: bold });
    page.drawText('Project: Hampton Inn Raleigh', { x: 46, y: 72, size: 8, font });
    page.drawText(title, { x: 260, y: 88, size: 10, font: bold });
    if (item) page.drawText(`Item: ${item}`, { x: 260, y: 72, size: 9, font });
    if (model) page.drawText(`Model: ${model}`, { x: 380, y: 72, size: 9, font });
    page.drawText(sheet, { x: 600, y: 88, size: 9, font });
    page.drawText('Drawn: KM   Scale: 1" = 1\'-0"', { x: 600, y: 72, size: 7, font });
  };
  const sheets: [string | null, string | null, string, string, string[]][] = [
    [
      'CG-101',
      'HB-8054',
      'KING HEADBOARD – ELEVATION',
      'Sheet 1 of 2',
      ['80" OVERALL WIDTH', '54" HEIGHT', 'FRENCH CLEAT MOUNT'],
    ],
    [
      null,
      null,
      'KING HEADBOARD – SECTIONS & DETAILS',
      'Sheet 2 of 2',
      ['SECTION A-A', 'DETAIL 3: CLEAT', 'EDGE PROFILE 1/8" RADIUS'],
    ],
    ['CG-102', 'NS-2418', 'NIGHTSTAND – PLAN & ELEVATION', 'Sheet 1 of 3', ['24" W', '18" D', '26" H']],
    [
      null,
      null,
      'NIGHTSTAND – DRAWER DETAILS',
      'Sheet 2 of 3',
      ['FULL EXTENSION SLIDES', 'DOVETAIL JOINERY'],
    ],
    [null, null, 'NIGHTSTAND – HARDWARE', 'Sheet 3 of 3', ['PULL: 4" CC BRUSHED NICKEL']],
    [
      'DK-4824',
      null,
      'WORK DESK WITH POWER GROMMET',
      'Sheet 1 of 1',
      ['48" W x 24" D x 30" H', 'GROMMET 3" DIA'],
    ],
  ];
  for (const [item, model, title, sheet, notes] of sheets) {
    const page = doc.addPage([792, 612]);
    let y = 540;
    for (const n of notes) {
      page.drawText(n, { x: 120, y, size: 9, font });
      y -= 40;
    }
    page.drawRectangle({
      x: 300,
      y: 200,
      width: 300,
      height: 220,
      borderColor: rgb(0.3, 0.3, 0.3),
      borderWidth: 1,
    });
    titleBlock(page, item, model, title, sheet);
  }
  return doc.save();
}

/** A PDF whose second page has no text layer (simulated scan). */
export async function scannedPdf(): Promise<Uint8Array> {
  const { doc, font } = await newDoc();
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Cover sheet with enough text to be readable', { x: 54, y: 700, size: 12, font });
  const p2 = doc.addPage([612, 792]);
  p2.drawRectangle({ x: 50, y: 50, width: 500, height: 600, color: rgb(0.9, 0.9, 0.9) });
  return doc.save();
}

export const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
