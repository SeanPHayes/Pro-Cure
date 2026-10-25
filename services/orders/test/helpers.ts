import { withOwner } from '@procure/platform';
import { auth, type World } from '@procure/platform/testing';
import type { Mock } from 'vitest';
import type * as Clients from '../src/clients.js';

/**
 * Fixtures for integration tests. `../src/clients.js` is replaced by vi.mock in each test file; these helpers
 * program the mocks with a quote, vendors and a project that belong to a createWorld() tenant.
 */
export type Mocked = {
  [K in keyof typeof Clients]: (typeof Clients)[K] extends (...a: any) => any ? Mock : never;
};

export interface Fixture {
  projectId: string;
  quoteId: string;
  vendorA: string;
  vendorB: string;
  lines: Record<string, string>;
  managerId: string;
}

let n = 0;
export function setupQuote(
  c: Mocked,
  w: World,
  opts: { leadA?: number; depositA?: number; originB?: 'international' } = {},
): Fixture {
  n++;
  const f: Fixture = {
    projectId: crypto.randomUUID(),
    quoteId: crypto.randomUUID(),
    vendorA: crypto.randomUUID(),
    vendorB: crypto.randomUUID(),
    managerId: crypto.randomUUID(),
    lines: {
      cg: crypto.randomUUID(),
      ss: crypto.randomUUID(),
      lt: crypto.randomUUID(),
      nr: crypto.randomUUID(),
    },
  };
  const line = (
    id: string,
    code: string,
    category: string,
    vendorId: string,
    qty: number,
    cost: number,
    ready = true,
  ) => ({
    id,
    specId: crypto.randomUUID(),
    code,
    name: `${code} item`,
    description: `${code} description`,
    category,
    vendorId,
    vendorSku: `SKU-${code}`,
    finish: 'Walnut',
    dimensions: '60x20x30',
    locationName: 'Guestrooms',
    quantity: qty,
    unitCost: cost,
    unitPrice: cost * 1.4,
    readyToOrder: ready,
    poId: null,
  });
  const lines = [
    line(f.lines.cg!, 'CG-1', 'casegoods', f.vendorA, 120, 450.5),
    line(f.lines.ss!, 'SS-1', 'soft_seating', f.vendorA, 40, 899.99),
    line(f.lines.lt!, 'LT-1', 'lighting', f.vendorB, 200, 85.25),
    line(f.lines.nr!, 'MR-1', 'mirrors', f.vendorB, 10, 120, false),
  ];
  c.getOrderLines.mockImplementation(async (_t: string, quoteId: string, ids?: string[]) => ({
    quote: {
      id: quoteId,
      number: `Q-26-00${n}`,
      name: 'Guestrooms',
      projectId: f.projectId,
      status: 'client_approved',
    },
    lines: ids?.length ? lines.filter((l) => ids.includes(l.id)) : lines,
  }));
  c.getVendor.mockImplementation(async (_t: string, id: string) =>
    id === f.vendorA
      ? {
          id,
          name: 'Acme Casegoods',
          orgId: w.vendorOrgId,
          website: null,
          categories: ['casegoods'],
          profile: {
            leadTimeWeeks: opts.leadA ?? 12,
            shipMethod: 'LTL',
            freightTerms: 'FOB origin',
            paymentTerms: 'Net 30',
            depositPct: opts.depositA ?? 50,
            primaryContact: { name: 'Val Vendor', email: 'val@acme.example', phone: '555-0100' },
            rating: 4,
            onTimeRate: 0.9,
            preferred: true,
            accountNumber: null,
          },
        }
      : {
          id,
          name: 'Bright Lighting',
          orgId: null,
          website: null,
          categories: ['lighting'],
          profile: {
            leadTimeWeeks: 8,
            shipMethod: 'Parcel',
            freightTerms: null,
            paymentTerms: 'Net 45',
            depositPct: 0,
            primaryContact: { name: 'Bea', email: 'bea@bright.example', phone: null },
            rating: null,
            onTimeRate: null,
            preferred: false,
            accountNumber: null,
            origin: opts.originB ?? 'domestic',
            transitDays: null,
          },
        },
  );
  c.getProject.mockImplementation(async () => ({
    id: f.projectId,
    number: `P-26-00${n}`,
    name: 'Hilton Austin Renovation',
    propertyName: 'Hilton Austin',
    brandId: null,
    clientOrgId: w.clientOrgId,
    address: { line1: '500 E 4th St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
    shipToAddress: {},
    targetOpenDate: '2027-06-01',
    stage: 'procurement',
    status: 'active',
    team: [
      { userId: f.managerId, name: 'Olivia Order', email: 'olivia@jmhs.example', role: 'order_manager' },
    ],
    contacts: [
      {
        name: 'Sam Site',
        email: 'sam@hotel.example',
        phone: '555-0199',
        company: 'Hilton',
        role: 'GM',
        isDeliveryRecipient: true,
      },
    ],
  }));
  c.getOrg.mockResolvedValue({
    id: w.tenantId,
    name: 'JMHS',
    address: {},
    phone: null,
    email: null,
    website: null,
  });
  c.renderReport.mockImplementation(async (b: any) => ({
    id: crypto.randomUUID(),
    filename: b.filename,
    contentType: 'application/pdf',
    downloadUrl: '/x',
  }));
  c.openThread.mockResolvedValue(null);
  return f;
}

export const json = (
  method: string,
  url: string,
  token: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) => ({
  method: method as 'GET',
  url,
  headers: { ...auth(token), ...headers },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});

/** Outbox rows written for a tenant, optionally filtered by type. */
export async function outbox(tenantId: string, type?: string) {
  return withOwner(
    (tx) => tx<{ type: string; data: any }[]>`
      select type, data from platform.outbox where tenant_id = ${tenantId}
      ${type ? tx`and type = ${type}` : tx``} order by occurred_at, id`,
  );
}

/** Run SQL as the schema owner (bypasses nothing — owner is subject to FORCE RLS only under the app role). */
export const owner = withOwner;
