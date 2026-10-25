import { tokenFor } from '@procure/platform/testing';
import type { Ctx } from './business.js';
import { VENDORS } from './people.js';

/**
 * Shared intelligence: brands and their FF&E standard packages (published by the Pro-Cure curator so
 * every firm sees them), the vendor network with JMHS's private terms, and a product catalog.
 *
 * Package content is representative of focused-service brand standards; codes and descriptions are
 * illustrative, not copied from any brand's documents.
 */

type Item = {
  code: string;
  area: string;
  category: string;
  name: string;
  description?: string;
  dimensions?: string;
  finish?: string;
  materials?: string;
  quantityBasis?: string;
  vendors?: string[];
};

const GUESTROOM: Item[] = [
  {
    code: 'CG-01',
    area: 'Guestroom',
    category: 'casegoods',
    name: 'King headboard, panel with integrated reading lights',
    dimensions: '80"W x 2"D x 54"H',
    finish: 'Thermofoil walnut, matte',
    materials: 'MDF core, HPL edge',
    quantityBasis: '1 per king room',
    vendors: ['carolina', 'pacific'],
  },
  {
    code: 'CG-02',
    area: 'Guestroom',
    category: 'casegoods',
    name: 'Queen headboard, panel',
    dimensions: '64"W x 2"D x 54"H',
    finish: 'Thermofoil walnut, matte',
    materials: 'MDF core, HPL edge',
    quantityBasis: '2 per queen/queen room',
    vendors: ['carolina', 'pacific'],
  },
  {
    code: 'CG-03',
    area: 'Guestroom',
    category: 'casegoods',
    name: 'Nightstand, wall-hung with drawer',
    dimensions: '22"W x 18"D x 9"H',
    finish: 'Thermofoil walnut; quartz-look top',
    materials: 'MDF, HPL top',
    quantityBasis: '2 per king room (L/R)',
    vendors: ['carolina', 'pacific'],
  },
  {
    code: 'CG-04',
    area: 'Guestroom',
    category: 'casegoods',
    name: 'Multi-function media unit with fridge cabinet',
    dimensions: '72"W x 22"D x 32"H',
    finish: 'Thermofoil walnut / painted white',
    materials: 'MDF, HPL',
    quantityBasis: '1 per room',
    vendors: ['carolina', 'pacific'],
  },
  {
    code: 'CG-05',
    area: 'Guestroom',
    category: 'casegoods',
    name: 'Open wardrobe with luggage bench',
    dimensions: '42"W x 24"D x 84"H',
    finish: 'Painted white, walnut bench',
    materials: 'MDF, steel rod',
    quantityBasis: '1 per room',
    vendors: ['carolina'],
  },
  {
    code: 'CG-06',
    area: 'Guestroom',
    category: 'casegoods',
    name: 'Work desk, wall-mounted with modesty panel',
    dimensions: '48"W x 24"D x 30"H',
    finish: 'Thermofoil walnut',
    materials: 'MDF, steel bracket',
    quantityBasis: '1 per room',
    vendors: ['carolina', 'pacific'],
  },
  {
    code: 'ST-01',
    area: 'Guestroom',
    category: 'seating',
    name: 'Desk chair, upholstered, swivel on casters',
    dimensions: '24"W x 24"D x 34"H',
    finish: 'Performance vinyl, charcoal',
    materials: 'Steel base, molded foam',
    quantityBasis: '1 per room',
    vendors: ['northline'],
  },
  {
    code: 'ST-02',
    area: 'Guestroom',
    category: 'soft_seating',
    name: 'Lounge chair with metal legs',
    dimensions: '30"W x 31"D x 33"H',
    finish: 'Crypton fabric, slate',
    materials: 'Hardwood frame, powder-coat legs',
    quantityBasis: '1 per king room',
    vendors: ['northline'],
  },
  {
    code: 'ST-03',
    area: 'Guestroom',
    category: 'soft_seating',
    name: 'Sleeper sofa, queen mechanism',
    dimensions: '84"W x 38"D x 34"H',
    finish: 'Crypton fabric, slate',
    materials: 'Hardwood frame, memory foam mattress',
    quantityBasis: '1 per suite',
    vendors: ['northline'],
  },
  {
    code: 'ST-04',
    area: 'Guestroom',
    category: 'seating',
    name: 'Ottoman, round',
    dimensions: '20" dia x 18"H',
    finish: 'Performance vinyl, mustard',
    quantityBasis: '1 per king room',
    vendors: ['northline'],
  },
  {
    code: 'TB-01',
    area: 'Guestroom',
    category: 'tables',
    name: 'Occasional table, round pedestal',
    dimensions: '20" dia x 22"H',
    finish: 'Black metal, walnut top',
    quantityBasis: '1 per king room',
    vendors: ['carolina', 'pacific'],
  },
  {
    code: 'LT-01',
    area: 'Guestroom',
    category: 'lighting',
    name: 'Floor lamp, arc',
    dimensions: '64"H',
    finish: 'Matte black, linen shade',
    materials: 'Steel, fabric shade',
    quantityBasis: '1 per room',
    vendors: ['lumen'],
  },
  {
    code: 'LT-02',
    area: 'Guestroom',
    category: 'lighting',
    name: 'Desk task lamp with USB-C',
    dimensions: '18"H',
    finish: 'Brushed brass',
    quantityBasis: '1 per room',
    vendors: ['lumen'],
  },
  {
    code: 'LT-03',
    area: 'Guestroom',
    category: 'lighting',
    name: 'Bathroom vanity sconce, linear LED',
    dimensions: '24"W',
    finish: 'Brushed nickel',
    quantityBasis: '1 per bathroom',
    vendors: ['lumen'],
  },
  {
    code: 'MR-01',
    area: 'Guestroom bath',
    category: 'mirrors',
    name: 'Vanity mirror, backlit, round with defogger',
    dimensions: '30" dia',
    quantityBasis: '1 per bathroom',
    vendors: ['lumen'],
  },
  {
    code: 'MR-02',
    area: 'Guestroom',
    category: 'mirrors',
    name: 'Full-length mirror, framed',
    dimensions: '24"W x 66"H',
    finish: 'Matte black frame',
    quantityBasis: '1 per room',
    vendors: ['lumen'],
  },
  {
    code: 'WC-01',
    area: 'Guestroom',
    category: 'window_treatments',
    name: 'Blackout drapery, ripplefold',
    finish: 'Charcoal woven, 3-pass blackout',
    materials: 'Inherently FR polyester',
    quantityBasis: 'per window width',
    vendors: ['harbor'],
  },
  {
    code: 'WC-02',
    area: 'Guestroom',
    category: 'window_treatments',
    name: 'Sheer drapery, ripplefold',
    finish: 'Ivory sheer',
    materials: 'Inherently FR polyester',
    quantityBasis: 'per window width',
    vendors: ['harbor'],
  },
  {
    code: 'BD-01',
    area: 'Guestroom',
    category: 'bedding',
    name: 'Decorative bed scarf, king',
    finish: 'Woven pattern, slate/mustard',
    quantityBasis: '1 per king bed',
    vendors: ['harbor'],
  },
  {
    code: 'CP-01',
    area: 'Guestroom',
    category: 'carpet',
    name: 'Guestroom carpet tile, 24x24',
    finish: 'Pattern "Fieldstone", color 0412',
    materials: 'Solution-dyed nylon 6,6',
    quantityBasis: 'sq yd per room type',
    vendors: ['meridian'],
  },
  {
    code: 'FL-01',
    area: 'Guestroom',
    category: 'flooring',
    name: 'LVT plank, entry and bath',
    dimensions: '7" x 48"',
    finish: 'Natural oak',
    materials: '20 mil wear layer',
    quantityBasis: 'sq ft per room type',
    vendors: ['meridian'],
  },
  {
    code: 'AR-01',
    area: 'Guestroom',
    category: 'artwork',
    name: 'Framed art over headboard, regional photography',
    dimensions: '40"W x 30"H',
    quantityBasis: '1 per room',
  },
];

const PUBLIC: Item[] = [
  {
    code: 'PL-01',
    area: 'Lobby',
    category: 'soft_seating',
    name: 'Lobby lounge sofa, tight back',
    dimensions: '90"W x 36"D x 31"H',
    finish: 'Performance velvet, forest',
    vendors: ['northline'],
  },
  {
    code: 'PL-02',
    area: 'Lobby',
    category: 'soft_seating',
    name: 'Lobby lounge chair, swivel',
    dimensions: '32"W x 33"D x 30"H',
    finish: 'Performance boucle, oat',
    vendors: ['northline'],
  },
  {
    code: 'PL-03',
    area: 'Lobby',
    category: 'tables',
    name: 'Communal table with power',
    dimensions: '120"W x 42"D x 30"H',
    finish: 'Solid walnut, blackened steel base',
    vendors: ['carolina'],
  },
  {
    code: 'PL-04',
    area: 'Lobby',
    category: 'lighting',
    name: 'Pendant cluster over communal table',
    finish: 'Smoked glass, brass',
    vendors: ['lumen'],
  },
  {
    code: 'PB-01',
    area: 'Breakfast',
    category: 'seating',
    name: 'Breakfast dining chair, upholstered seat',
    dimensions: '20"W x 22"D x 32"H',
    finish: 'Walnut, vinyl seat',
    vendors: ['northline'],
  },
  {
    code: 'PB-02',
    area: 'Breakfast',
    category: 'tables',
    name: 'Breakfast table, 30x30 with bolt-down base',
    dimensions: '30" x 30" x 30"H',
    finish: 'Quartz-look laminate',
    vendors: ['carolina', 'pacific'],
  },
  {
    code: 'PB-03',
    area: 'Breakfast',
    category: 'millwork',
    name: 'Breakfast buffet millwork',
    finish: 'Painted, solid surface top',
    vendors: ['carolina'],
  },
  {
    code: 'PF-01',
    area: 'Fitness',
    category: 'other',
    name: 'Fitness mirror wall',
    dimensions: 'Field measure',
  },
  {
    code: 'PC-01',
    area: 'Corridors',
    category: 'carpet',
    name: 'Corridor broadloom, 12 ft',
    finish: 'Pattern "Linear Drift"',
    materials: 'Solution-dyed nylon',
    vendors: ['meridian'],
  },
  {
    code: 'PO-01',
    area: 'Exterior',
    category: 'outdoor',
    name: 'Patio lounge set (sofa, 2 chairs, table)',
    finish: 'Powder-coat aluminum, Sunbrella cushions',
    vendors: ['pacific'],
  },
];

const BRANDS = [
  {
    name: 'Home2 Suites by Hilton',
    parentCompany: 'Hilton',
    segment: 'Extended stay',
    prefix: 'H2',
    palette: 'Walnut & slate',
  },
  {
    name: 'Hampton by Hilton',
    parentCompany: 'Hilton',
    segment: 'Focused service',
    prefix: 'HX',
    palette: 'Oak & navy',
  },
  {
    name: 'Tru by Hilton',
    parentCompany: 'Hilton',
    segment: 'Midscale',
    prefix: 'TR',
    palette: 'Bold color blocking',
  },
  {
    name: 'Courtyard by Marriott',
    parentCompany: 'Marriott',
    segment: 'Select service',
    prefix: 'CY',
    palette: 'Warm neutrals',
  },
  {
    name: 'Holiday Inn Express',
    parentCompany: 'IHG',
    segment: 'Focused service',
    prefix: 'HIX',
    palette: 'Fresh blue',
  },
];

const PRODUCTS: Record<
  string,
  {
    sku: string;
    name: string;
    category: string;
    dimensions?: string;
    finishes?: string[];
    lead?: number;
    codes?: string[];
  }[]
> = {
  carolina: [
    {
      sku: 'CC-HB80-W',
      name: 'Panel headboard 80" with reading lights',
      category: 'casegoods',
      dimensions: '80"W x 54"H',
      finishes: ['Walnut thermofoil', 'Oak thermofoil'],
      lead: 14,
      codes: ['CG-01'],
    },
    {
      sku: 'CC-HB64-W',
      name: 'Panel headboard 64"',
      category: 'casegoods',
      dimensions: '64"W x 54"H',
      finishes: ['Walnut thermofoil'],
      lead: 14,
      codes: ['CG-02'],
    },
    {
      sku: 'CC-NS22-WH',
      name: 'Wall-hung nightstand with drawer',
      category: 'casegoods',
      dimensions: '22"W x 18"D',
      lead: 14,
      codes: ['CG-03'],
    },
    {
      sku: 'CC-MU72',
      name: 'Media unit with fridge cabinet',
      category: 'casegoods',
      dimensions: '72"W x 22"D x 32"H',
      lead: 14,
      codes: ['CG-04'],
    },
    {
      sku: 'CC-WR42',
      name: 'Open wardrobe with luggage bench',
      category: 'casegoods',
      lead: 14,
      codes: ['CG-05'],
    },
    { sku: 'CC-DK48-WM', name: 'Wall-mounted desk 48"', category: 'casegoods', lead: 14, codes: ['CG-06'] },
    {
      sku: 'CC-CT120',
      name: 'Communal table 120" with power',
      category: 'tables',
      lead: 12,
      codes: ['PL-03'],
    },
  ],
  northline: [
    {
      sku: 'NS-2210',
      name: 'Ardent task chair',
      category: 'seating',
      dimensions: '24"W x 24"D x 34"H',
      finishes: ['Charcoal vinyl', 'Navy vinyl'],
      lead: 10,
      codes: ['ST-01'],
    },
    { sku: 'NS-3140', name: 'Harlow lounge chair', category: 'soft_seating', lead: 10, codes: ['ST-02'] },
    {
      sku: 'NS-5590',
      name: 'Sutton queen sleeper sofa',
      category: 'soft_seating',
      lead: 12,
      codes: ['ST-03'],
    },
    { sku: 'NS-1020', name: 'Pip round ottoman', category: 'seating', lead: 8, codes: ['ST-04'] },
    { sku: 'NS-7700', name: 'Bennett lobby sofa', category: 'soft_seating', lead: 12, codes: ['PL-01'] },
    {
      sku: 'NS-7710',
      name: 'Bennett swivel lounge chair',
      category: 'soft_seating',
      lead: 12,
      codes: ['PL-02'],
    },
    { sku: 'NS-4405', name: 'Mesa dining chair', category: 'seating', lead: 9, codes: ['PB-01'] },
  ],
  lumen: [
    { sku: 'LF-FL64-BK', name: 'Arc floor lamp, black', category: 'lighting', lead: 8, codes: ['LT-01'] },
    {
      sku: 'LF-TL18-BB',
      name: 'Task lamp with USB-C, brushed brass',
      category: 'lighting',
      lead: 8,
      codes: ['LT-02'],
    },
    { sku: 'LF-VS24-BN', name: 'Linear vanity sconce 24"', category: 'lighting', lead: 6, codes: ['LT-03'] },
    {
      sku: 'LF-MR30-LED',
      name: 'Round backlit mirror 30" with defogger',
      category: 'mirrors',
      lead: 8,
      codes: ['MR-01'],
    },
    {
      sku: 'LF-PC5-SG',
      name: 'Five-light pendant cluster, smoked glass',
      category: 'lighting',
      lead: 10,
      codes: ['PL-04'],
    },
  ],
  pacific: [
    {
      sku: 'PRF-HB80',
      name: 'Headboard 80" panel (import)',
      category: 'casegoods',
      lead: 16,
      codes: ['CG-01'],
    },
    {
      sku: 'PRF-NS22',
      name: 'Nightstand wall-hung (import)',
      category: 'casegoods',
      lead: 16,
      codes: ['CG-03'],
    },
    { sku: 'PRF-DK48', name: 'Desk 48" (import)', category: 'casegoods', lead: 16, codes: ['CG-06'] },
    { sku: 'PRF-PATIO4', name: 'Patio lounge set, 4 pc', category: 'outdoor', lead: 18, codes: ['PO-01'] },
  ],
  harbor: [
    {
      sku: 'HT-BO-RF',
      name: 'Ripplefold blackout drapery panel',
      category: 'window_treatments',
      lead: 6,
      codes: ['WC-01'],
    },
    {
      sku: 'HT-SH-RF',
      name: 'Ripplefold sheer panel',
      category: 'window_treatments',
      lead: 6,
      codes: ['WC-02'],
    },
    { sku: 'HT-BS-K', name: 'King bed scarf', category: 'bedding', lead: 5, codes: ['BD-01'] },
  ],
  meridian: [
    {
      sku: 'MCM-FS2424',
      name: 'Fieldstone carpet tile 24x24',
      category: 'carpet',
      lead: 7,
      codes: ['CP-01'],
    },
    { sku: 'MCM-LVT748', name: 'Natural oak LVT plank', category: 'flooring', lead: 5, codes: ['FL-01'] },
    { sku: 'MCM-LD12', name: 'Linear Drift broadloom 12 ft', category: 'carpet', lead: 7, codes: ['PC-01'] },
  ],
};

export async function seed(ctx: Ctx) {
  const { call, staff, ids } = ctx;
  const curator = {
    name: 'Catalog Curation',
    token: await tokenFor({
      userId: ids.curatorId,
      orgId: ids.platformOrgId,
      tenantId: ids.platformOrgId,
      actor: 'platform',
      roles: ['catalog_curator'],
      name: 'Catalog Curation',
      email: 'curation@pro-cure.example',
      orgName: 'Pro-Cure Network',
    }),
  };

  // --- vendors (network record + JMHS's private terms) --------------------------------------
  const vendorIds: Record<string, string> = {};
  for (const v of VENDORS) {
    const created = await call(staff.marcus, 'catalog', 'POST', '/vendors', {
      name: v.name,
      orgId: ctx.ids.vendorOrgs[v.key] ?? null,
      website: v.website,
      emailDomains: [v.domain],
      categories: v.categories,
      hqCity: v.hq.city,
      hqRegion: v.hq.region,
      hqCountry: v.hq.country,
      description: `${v.name} manufactures hospitality ${v.categories.join(', ').replace(/_/g, ' ')}.`,
      force: true,
      profile: {
        accountNumber: `JMHS-${v.key.toUpperCase().slice(0, 4)}-${100 + Object.keys(vendorIds).length}`,
        paymentTerms: v.paymentTerms,
        depositPct: v.depositPct,
        leadTimeWeeks: v.leadTimeWeeks,
        shipMethod: v.shipMethod,
        freightTerms: v.freightTerms,
        origin: v.origin,
        transitDays: v.origin === 'international' ? 35 : 5,
        primaryContact: v.contact,
        contacts: [v.contact],
        rating: v.rating,
        preferred: v.preferred,
        tags: v.preferred ? ['preferred'] : [],
      },
    });
    vendorIds[v.key] = created.id;
  }
  ctx.out.vendorIds = vendorIds;

  // --- brands & published standards ------------------------------------------------------------
  const brands: Record<string, string> = {};
  const standards: Record<string, { id: string; items: any[] }> = {};
  for (const b of BRANDS) {
    const brand = await call(curator, 'catalog', 'POST', '/brands', {
      name: b.name,
      parentCompany: b.parentCompany,
      segment: b.segment,
    });
    brands[b.name] = brand.id;
    for (const [pkg, items] of [
      ['Guestroom FF&E', GUESTROOM],
      ['Public areas FF&E', PUBLIC],
    ] as const) {
      const std = await call(curator, 'catalog', 'POST', '/brand-standards', {
        brandId: brand.id,
        name: `${b.name} – ${pkg}`,
        version: '2026.1',
        effectiveDate: '2026-01-01',
        notes: `Palette: ${b.palette}. Representative package for demo purposes.`,
        items: items.map((it, i) => ({
          code: `${b.prefix}-${it.code}`,
          area: it.area,
          category: it.category,
          name: it.name,
          description: it.description ?? null,
          dimensions: it.dimensions ?? null,
          finish: it.finish ?? null,
          materials: it.materials ?? null,
          quantityBasis: it.quantityBasis ?? null,
          approvedVendors: (it.vendors ?? []).map((k) => ({
            vendorId: vendorIds[k],
            name: VENDORS.find((v) => v.key === k)!.name,
          })),
          sort: i,
        })),
      });
      await call(curator, 'catalog', 'POST', `/brand-standards/${std.id}/publish`, {});
      const full = await call(staff.marcus, 'catalog', 'GET', `/brand-standards/${std.id}`);
      standards[`${b.name}|${pkg}`] = { id: std.id, items: full.items };
    }
  }
  ctx.out.brands = brands;
  ctx.out.standards = standards;

  // --- products ---------------------------------------------------------------------------------
  const h2Guest = standards['Home2 Suites by Hilton|Guestroom FF&E']!.items;
  const h2Public = standards['Home2 Suites by Hilton|Public areas FF&E']!.items;
  const byCode = (code: string) =>
    [...h2Guest, ...h2Public].find((i: any) => i.code === `H2-${code}`)?.id as string | undefined;
  let n = 0;
  for (const [vk, list] of Object.entries(PRODUCTS)) {
    for (const p of list) {
      await call(staff.marcus, 'catalog', 'POST', '/products', {
        vendorId: vendorIds[vk],
        sku: p.sku,
        name: p.name,
        category: p.category,
        dimensions: p.dimensions ?? null,
        finishes: p.finishes ?? [],
        typicalLeadTimeWeeks: p.lead ?? null,
        brandStandardItemIds: (p.codes ?? []).map(byCode).filter(Boolean),
      });
      n++;
    }
  }
  console.log(
    `  ${VENDORS.length} vendors, ${BRANDS.length} brands, ${Object.keys(standards).length} standards, ${n} products`,
  );
}
