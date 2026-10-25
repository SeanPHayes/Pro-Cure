import type { Ctx } from './business.js';

/**
 * Conversations and the inbox: the firm's purchasing mailbox, a few team/vendor/owner messages, and
 * inbound vendor emails for the AI to route (one with a PO number and tracking, one pro-forma deposit
 * invoice, one ambiguous schedule update).
 */
export async function seed(ctx: Ctx) {
  const { call, staff, out } = ctx;
  const marcus = staff.marcus;
  await call(staff.sean, 'comms', 'POST', '/mailboxes', {
    address: 'purchasing@inbound.pro-cure.local',
  }).catch(() => null);

  const thread = async (
    who: any,
    entityType: string,
    entityId: string,
    visibility = 'internal',
    extra: Record<string, string> = {},
  ) => {
    const q = new URLSearchParams({ entityType, entityId, visibility, ...extra }).toString();
    return call<any>(who, 'comms', 'GET', `/threads/for?${q}`);
  };
  const post = (who: any, threadId: string, bodyText: string, mentions: string[] = []) =>
    call(who, 'comms', 'POST', `/threads/${threadId}/messages`, { bodyText, mentions });

  // Team chatter on Home2.
  const home2 = out.projects.home2;
  const t1 = await thread(staff.dana, 'project', home2.id);
  await post(
    staff.dana,
    t1.id,
    'Shop drawings for the casegoods package are in from Carolina. Priya, can you check the headboard reveal against the brand mock-up before they go to Hannah?',
    [ctx.ids.users.priya!],
  );
  await post(
    staff.priya,
    t1.id,
    'Reviewed — reveal is 3/4" vs 1/2" on the mock-up. I marked it up; sending back to Will today.',
  );
  await post(
    staff.marcus,
    t1.id,
    'Heads up: Lumen pushed the pendant ship date twice. I asked for a firm date by Friday or we look at the alternate.',
  );

  // Owner conversation on Home2.
  const hannah = ctx.clients['hannah@blueridgehg.example']!;
  const ownerThread = await thread(hannah, 'project', home2.id, 'client', {
    clientOrgId: ctx.ids.clientOrgs.blueridge!,
  });
  await post(
    hannah,
    ownerThread.id,
    'Can we confirm the guestroom FF&E will be on site before the 4th-floor turnover? Our GC needs a date for the elevator reservation.',
  );
  await post(
    staff.dana,
    ownerThread.id,
    'Yes — casegoods ship in two releases; the first lands about two weeks before the 4th-floor turnover. I will send the delivery schedule report this week.',
  );

  // Vendor conversation on a Hampton PO.
  const hxCarolina = (out.pos?.hampton ?? []).find((p: any) => p.vendorId === out.vendorIds.carolina);
  if (hxCarolina && ctx.vendors.carolina) {
    const vt = await thread(marcus, 'purchase_order', hxCarolina.id, 'vendor', {
      vendorOrgId: ctx.ids.vendorOrgs.carolina!,
    });
    await post(
      marcus,
      vt.id,
      'Will — two headboards from release A arrived damaged (claim opened). Can you send replacements with release B?',
    );
    await post(
      ctx.vendors.carolina,
      vt.id,
      'Sorry about that. Replacements are cut and will ride with release B. I updated the claim.',
    );
  }

  // Inbound vendor emails.
  const hxHarbor = (out.pos?.hampton ?? []).find((p: any) => p.vendorId === out.vendorIds.harbor);
  const emails = [
    hxHarbor && {
      from: 'shipping@harbortextiles.example',
      fromName: 'Harbor Textiles Shipping',
      to: 'purchasing@inbound.pro-cure.local',
      subject: `Shipped: ${hxHarbor.number} drapery — Hampton Inn Wilmington`,
      text: `Hello,\n\nYour order ${hxHarbor.number} shipped today via UPS Freight.\nTracking: 1Z4E7A060391567890\nEstimated delivery in 4 business days.\n\nThank you,\nHarbor Textiles`,
    },
    {
      from: 'ar@northlineseating.example',
      fromName: 'Northline Seating AR',
      to: 'purchasing@inbound.pro-cure.local',
      subject: 'Pro forma invoice — deposit required to release production',
      text: 'Please find attached our pro forma invoice for the 30% deposit on your recent seating order for the Home2 RDU project. Production will be released upon receipt.\n\nNorthline Seating',
    },
    {
      from: 'grace.lin@pacificrimfurniture.example',
      fromName: 'Grace Lin',
      to: 'purchasing@inbound.pro-cure.local',
      subject: 'Updated container schedule',
      text: 'Hi team,\n\nThe Yantian sailing moved one week due to port congestion. Our next container is now loading on the 14th. Let me know if this affects any of your projects.\n\nGrace',
    },
  ].filter(Boolean);
  for (const e of emails) await call(marcus, 'comms', 'POST', '/inbound/simulate', e);
  console.log(`  threads, messages and ${emails.length} inbound vendor emails`);
}
