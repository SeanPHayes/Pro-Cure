# Demo script

A 25-minute walkthrough that shows every capability, following one project from quote to install.
Run `pnpm db:reset && pnpm dev`, open http://localhost:5173, and sign in as the people below (the
sign-in screen lists everyone; use the account menu to sign out and switch).

The seeded portfolio: **Home2 Suites Raleigh-Durham Airport** (new build, 120 keys, in procurement),
**Hampton Inn Wilmington Riverfront** (renovation, phased floor by floor, in production/logistics),
**Tru by Hilton Cary** (quoting), plus two closed projects that give the risk model delivery history.

## 1. The portfolio view — Marcus Bell, Procurement Manager
- **Home**: what needs attention across all projects today — overdue tasks, POs whose order-by date is
  near with open requirements, shipments at risk, pricing that has expired.
- **My work**: the cross-portfolio task list filtered to *me / this week*. Complete a task and watch the
  next one in the template become ready and assigned.
- **⌘K**: jump to any project, quote or PO.

## 2. Shared brand standards → spec library — Priya Raman, Designer
- **Library › Brand standards**: the Hampton Inn guestroom package is already structured (shared across
  firms, so nobody re-keys it).
- **AI assistant › Brand spec PDF**: upload a brand-standard PDF; review the extracted items (codes,
  areas, finishes, approved vendors) and add them to the spec library in one click.

## 3. Building a quote — Priya / Marcus
- Open **Tru by Hilton Cary › Quote**. Rooms are set up by room type (King ×58, Queen/Queen ×36, …);
  each line's quantity is per room, so changing a room count updates every line.
- **Price matrix**: the desk chair slot has three competing vendors; pick the winner.
- **Merchandise**: set markups by category and area, or solve for a target margin.
- Flags call out missing or expired costs and lines below the minimum margin.

## 4. Vendor pricing — Marcus, then Kara Lindqvist (Northline Seating)
- **Request pricing** for expired lines → one request per vendor, emailed with a portal link (see
  **Settings › Email log**).
- Sign in as **Kara**: the vendor portal shows only her request — no sell prices, no other vendors.
  Enter costs, a corrected dimension, lead time; submit.
- Back as Marcus: **Compare** vendor vs. library vs. quote and apply — optionally updating the library
  spec so other quotes pick up the new cost.
- **AI › Vendor quote PDF**: for vendors who email a PDF instead, the AI reads it and matches lines.

## 5. Approval rules — Jordan Akers, Operations Executive
- Sending a quote with a line below the 18% margin floor creates an approval request instead.
  Approve it from **Approvals**.

## 6. The owner approves — Hannah Moore, Blue Ridge Hospitality
- Owner portal: the quote shows sell prices by area only. Approve with a typed signature.
- The project's "Client quote approval" milestone completes itself, and a deposit invoice is drafted
  for accounting.

## 7. Purchase orders and the order-by date — Marcus
- **Create purchase orders** from the approved lines: one PO per vendor with terms, lead time and
  default requirements (acknowledgement, deposit, shop drawings for casegoods).
- Each PO shows its **order-by date**: the last day every requirement must be done for production to
  meet the requested delivery.
- Split the casegoods PO into shipments by floor for the phased renovation. Issue it (PDF + email).
- Change a quantity after issuing → **Issue revision** produces a highlighted revision PDF.

## 8. Vendor fulfils — Will Harmon (Carolina Casegoods)
- Acknowledge the PO, upload shop drawings to the requirement, confirm the ship date, later add
  tracking. Each action notifies the team; tracking emails the delivery recipients automatically.

## 9. Logistics and risk — Tomás Ortega
- **Shipments**: everything shipping or delivering in the next two weeks across all projects.
- The **risk model** flags a shipment from the overseas vendor ("ships late 38% of the time; 4 days of
  slack") before it's late.
- **AI inbox**: a vendor email with a PO number and a UPS tracking number is routed to the PO thread
  automatically with a one-click "set tracking"; an ambiguous one waits in the **Inbox** with
  suggestions.
- **Drawing packet split**: upload a vendor's 6-page drawing packet; the AI assigns pages to specs and
  files each drawing on its spec (and into the spec book).

## 10. Site — Luis Ferreira, GM (owner portal)
- Live order status by item, tracking links, what's in on-site storage vs. installed.
- Approve shop drawings; report a damaged headboard with a photo → claim opened, team notified.
- Message the team on the project thread.

## 11. Money — Ellen Cho, Controller
- Project financials: contract value, committed cost, invoiced, collected, AP, projected margin.
- Send the deposit invoice (PDF + email; visible in the owner portal); record payment.
- **QuickBooks Online**: connect (simulated in the demo), sync customers, invoices, bills, payments;
  IIF/CSV export for the accountant.

## 12. Under the hood — Sean Hayes, admin
- **Activity** tab on any record: field-level history of who changed what.
- **Settings**: users and roles, connected vendors and owners, approval policies, task templates,
  integrations, email log.
- API docs for every service at `/api/<service>/docs`.
