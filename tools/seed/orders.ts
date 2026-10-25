import { withOwner } from '@procure/platform';
import type { Ctx } from './business.js';

/**
 * Purchase orders for the two approved quotes.
 *   Hampton (renovation, in logistics): everything issued and acknowledged; casegoods phased by floor;
 *     some shipments delivered (one late, one with damage → claim), others in transit or due soon.
 *   Home2 (new build, procurement): POs issued, shop drawings waiting for the owner, a ship date that
 *     keeps slipping, and one PO still in draft.
 */
export async function seed(ctx: Ctx) {
  const { call, day, staff, vendors, out } = ctx;
  const m = staff.marcus;
  const tomas = staff.tomas;
  const vendorKeyById = Object.fromEntries(
    Object.entries(out.vendorIds as Record<string, string>).map(([k, id]) => [id, k]),
  );

  const fromQuote = async (quoteId: string, requestedDeliveryDate: string) => {
    const lines = await call<any>(
      m,
      'quoting',
      'GET',
      `/quotes/${quoteId}/lines?selectedOnly=true&limit=2000`,
    );
    const lineIds = (lines.items ?? lines)
      .filter((l: any) => l.vendorId && l.readyToOrder && !l.poId)
      .map((l: any) => l.id);
    return (
      await call<any>(m, 'orders', 'POST', '/purchase-orders/from-quote', {
        quoteId,
        lineIds,
        requestedDeliveryDate,
      })
    ).items as any[];
  };
  const get = (id: string) => call<any>(m, 'orders', 'GET', `/purchase-orders/${id}`);
  const req = (po: any, kind: string) => po.requirements.find((r: any) => r.kind === kind);
  const setReq = (po: any, kind: string, status: string, note?: string) => {
    const r = req(po, kind);
    return r
      ? call(m, 'orders', 'PATCH', `/purchase-orders/${po.id}/requirements/${r.id}`, { status, note })
      : null;
  };
  const vendorOf = (po: any) => vendorKeyById[po.vendorId] as string;
  const acknowledge = async (po: any, shipDate: string) => {
    const v = vendors[vendorOf(po)];
    if (v)
      await call(v, 'orders', 'POST', `/vendor/purchase-orders/${po.id}/acknowledge`, {
        estimatedShipDate: shipDate,
        note: 'Order received and scheduled. Production slot confirmed.',
      });
    else {
      await setReq(po, 'order_acknowledgement', 'approved', 'Acknowledgement received by email');
      const fresh = await get(po.id);
      for (const s of fresh.shipments)
        await call(m, 'orders', 'PATCH', `/shipments/${s.id}`, { estimatedShipDate: shipDate });
    }
  };
  const clientApproveAll = async (projectId: string, email: string) => {
    const pending = await call<any>(
      ctx.clients[email]!,
      'orders',
      'GET',
      `/client/requirements?projectId=${projectId}&status=pending,submitted`,
    );
    for (const r of pending.items ?? pending)
      await call(ctx.clients[email]!, 'orders', 'POST', `/client/requirements/${r.id}/decision`, {
        decision: 'approved',
        note: 'Approved — matches the mock-up room.',
      });
  };
  const ship = (shipmentId: string, b: Record<string, unknown>) =>
    call(tomas, 'orders', 'PATCH', `/shipments/${shipmentId}`, b);
  const deliverAndReceive = async (
    po: any,
    s: any,
    deliveredOffset: number,
    locationId: string,
    damaged: Record<string, number> = {},
  ) => {
    await call(tomas, 'orders', 'POST', `/shipments/${s.id}/deliver`, {
      deliveredAt: `${day(deliveredOffset)}T15:00:00.000Z`,
    });
    const lines = s.lines.map((l: any) => ({
      poLineId: l.poLineId,
      qtyReceived: l.quantity - (damaged[l.poLineId] ?? 0),
      qtyDamaged: damaged[l.poLineId] ?? 0,
    }));
    await call(tomas, 'orders', 'POST', `/shipments/${s.id}/receive`, {
      receivedAt: `${day(deliveredOffset)}T16:00:00.000Z`,
      storageLocationId: locationId,
      lines,
      condition: Object.keys(damaged).length ? 'damaged' : 'good',
      notes: Object.keys(damaged).length
        ? 'Two headboard cartons crushed at the corner; panels cracked. Photos taken at the dock.'
        : 'Received complete, counts verified against packing list.',
    });
  };

  // ------------------------------------------------------------------ Hampton Inn (logistics)
  const hampton = out.projects.hampton;
  const whse = await call<any>(tomas, 'orders', 'POST', '/storage-locations', {
    projectId: hampton.id,
    name: 'Port City Warehousing — bay 14',
    kind: 'warehouse',
    address: { line1: '4100 US-421', city: 'Wilmington', region: 'NC', postalCode: '28401' },
  });
  const onsite = await call<any>(tomas, 'orders', 'POST', '/storage-locations', {
    projectId: hampton.id,
    name: 'Hotel — first-floor storage room 104',
    kind: 'on_site',
  });
  let hxPos = await fromQuote(out.quotes.hampton.quote.id, day(18));
  for (const po of hxPos)
    await call(m, 'orders', 'POST', `/purchase-orders/${po.id}/issue`, {
      message: 'Please confirm receipt and your production schedule.',
    });
  hxPos = await Promise.all(hxPos.map((p) => get(p.id)));
  const byVendor = (pos: any[], key: string) => pos.find((p) => vendorOf(p) === key);

  for (const po of hxPos) {
    const shipDate =
      vendorOf(po) === 'carolina'
        ? day(-24)
        : vendorOf(po) === 'northline'
          ? day(-4)
          : vendorOf(po) === 'lumen'
            ? day(-45)
            : vendorOf(po) === 'meridian'
              ? day(-16)
              : day(9);
    await acknowledge(po, shipDate);
  }
  await clientApproveAll(hampton.id, 'beth@coastallodging.example');

  // Casegoods: phase by floor — A (floors 1–2) delivered with damage, B (floors 3–4) ships next week.
  {
    const po = await get(byVendor(hxPos, 'carolina').id);
    const a = po.shipments[0];
    await call(tomas, 'orders', 'POST', `/shipments/${a.id}/split`, {
      label: 'B',
      note: 'Floors 3–4',
      requestedDeliveryDate: day(18),
      estimatedShipDate: day(6),
      lines: a.lines
        .map((l: any) => ({ poLineId: l.poLineId, quantity: Math.floor(l.quantity / 2) }))
        .filter((l: any) => l.quantity > 0),
    });
    await ship(a.id, { note: 'Floors 1–2', requestedDeliveryDate: day(-12) });
    await ship(a.id, {
      actualShipDate: day(-24),
      carrier: 'Estes Express',
      trackingNumber: 'PRO 0473-182-559',
      status: 'shipped',
    });
    const fresh = await get(po.id);
    const shipA = fresh.shipments.find((s: any) => s.id === a.id);
    const headboard = fresh.lines.find((l: any) => /headboard/i.test(l.name));
    await deliverAndReceive(fresh, shipA, -14, whse.id, headboard ? { [headboard.id]: 2 } : {});
  }
  // Seating: shipped, in transit with tracking.
  {
    const po = byVendor(hxPos, 'northline');
    if (po) {
      const s = (await get(po.id)).shipments[0];
      await call(vendors.northline!, 'orders', 'POST', `/vendor/shipments/${s.id}/tracking`, {
        carrier: 'XPO Logistics',
        trackingNumber: '493-77120-4',
        shipDate: day(-4),
      });
    }
  }
  // Lighting: delivered late (history for the risk model).
  {
    const po = byVendor(hxPos, 'lumen');
    if (po) {
      const s = (await get(po.id)).shipments[0];
      await ship(s.id, {
        requestedDeliveryDate: day(-50),
        actualShipDate: day(-45),
        carrier: 'UPS',
        trackingNumber: '1Z999AA10123456784',
        status: 'shipped',
      });
      const fresh = await get(po.id);
      await deliverAndReceive(fresh, fresh.shipments[0], -41, onsite.id);
    }
  }
  // Carpet: delivered on time.
  {
    const po = byVendor(hxPos, 'meridian');
    if (po) {
      const s = (await get(po.id)).shipments[0];
      await ship(s.id, {
        requestedDeliveryDate: day(-10),
        actualShipDate: day(-16),
        carrier: 'Southeastern Freight',
        trackingNumber: 'SEF 88214093',
        status: 'shipped',
      });
      const fresh = await get(po.id);
      await deliverAndReceive(fresh, fresh.shipments[0], -11, whse.id);
    }
  }

  // ------------------------------------------------------------------ Home2 (procurement)
  const home2 = out.projects.home2;
  let h2Pos = await fromQuote(out.quotes.home2.quote.id, day(112));
  const draftKeep = h2Pos.find((p) => vendorOf(p) === 'pacific');
  for (const po of h2Pos) {
    if (po === draftKeep) continue;
    await call(m, 'orders', 'POST', `/purchase-orders/${po.id}/issue`, {
      message: 'Home2 RDU — please acknowledge and confirm the production slot.',
    });
  }
  h2Pos = await Promise.all(h2Pos.map((p) => get(p.id)));
  for (const po of h2Pos) {
    if (po.status === 'draft') continue;
    if (vendorOf(po) === 'carolina') await acknowledge(po, day(70));
    if (vendorOf(po) === 'lumen') await acknowledge(po, day(78));
    if (vendorOf(po) === 'meridian') await acknowledge(po, day(90));
    // Northline and Harbor haven't acknowledged yet — shows up as pending vendor requirements.
  }
  // Lighting keeps slipping: the vendor pushes the ship date twice through ship-date confirmations.
  {
    const po = byVendor(h2Pos, 'lumen');
    if (po && vendors.lumen) {
      const s = (await get(po.id)).shipments[0];
      await call(vendors.lumen, 'orders', 'POST', `/vendor/shipments/${s.id}/confirm`, {
        onTrack: false,
        newShipDate: day(88),
        note: 'Glass supplier delay on the pendant shades.',
      });
      await call(vendors.lumen, 'orders', 'POST', `/vendor/shipments/${s.id}/confirm`, {
        onTrack: false,
        newShipDate: day(101),
        note: 'Second delay — new glass lot failed QC.',
      });
    }
  }
  // Release-by pressure: pull Carolina's requested delivery in so its order-by date is close and the
  // owner still hasn't approved shop drawings.
  {
    const po = byVendor(h2Pos, 'carolina');
    if (po) {
      await call(m, 'orders', 'PATCH', `/purchase-orders/${po.id}`, { requestedDeliveryDate: day(105) });
    }
  }
  // Delivery recipients for Home2 come from project contacts automatically; add the GC's super.
  await call(tomas, 'orders', 'POST', `/projects/${home2.id}/delivery-recipients`, {
    name: 'Mike Duarte (Summit Builders super)',
    email: 'mike.duarte@summitbuilders.example',
    phone: '(919) 555-0161',
  }).catch(() => null);

  // The hotel GM reports damage found when unpacking a delivered item.
  {
    const lumenPo = byVendor(hxPos, 'lumen');
    if (lumenPo)
      await call(ctx.clients['beth@coastallodging.example']!, 'orders', 'POST', '/client/claims', {
        projectId: hampton.id,
        poId: lumenPo.id,
        type: 'concealed_damage',
        description:
          'Two floor lamps arrived with bent stems — found when the cartons were opened in room 214.',
      });
  }

  // Back-date "issued" timestamps so the portfolio doesn't look like it all happened today.
  await withOwner(async (tx) => {
    await tx`update orders.purchase_orders set order_date = ${day(-75)}::date, issued_at = ${day(-75)}::date + time '10:00'
             where tenant_id = ${ctx.ids.tenantId} and project_id = ${hampton.id} and issued_at is not null`;
    await tx`update orders.purchase_orders set order_date = ${day(-9)}::date, issued_at = ${day(-9)}::date + time '10:00'
             where tenant_id = ${ctx.ids.tenantId} and project_id = ${home2.id} and issued_at is not null`;
  });
  out.pos = { hampton: hxPos, home2: h2Pos };
  console.log(`  ${hxPos.length + h2Pos.length} purchase orders, shipments, receipts, claims`);
}
