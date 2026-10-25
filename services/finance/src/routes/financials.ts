import { marginPct, round2, sum } from '@procure/domain';
import { type App, type Db, z } from '@procure/platform';
import { clients, type PoSummary, type QuoteSummary, tolerant } from '../clients.js';
import { addDays, agingBucket, emptyAging, lastMonths } from '../domain/invoicing.js';
import { today } from '../repo.js';
import { Portfolio, ProjectFinancials } from '../schemas.js';

const TAGS = ['financials'];
const CONTRACT_STATUSES = ['client_approved', 'ordered'];
const COMMITTED_PO_STATUSES_EXCLUDED = ['draft', 'cancelled'];

interface LedgerTotals {
  invoiced: number;
  collected: number;
  arBalance: number;
  overdueAr: number;
  apBilled: number;
  apPaid: number;
  apOpen: number;
  depositsCollected: number;
}

/** AR/AP totals per project from finance's own tables (always available). */
async function ledger(tx: Db, projectIds: string[] | null): Promise<Map<string, LedgerTotals>> {
  const filter = (col: string) => (projectIds ? tx`and ${tx(col)} in ${tx(projectIds)}` : tx``);
  const [ar, ap] = await Promise.all([
    tx<
      {
        projectId: string;
        invoiced: number;
        collected: number;
        arBalance: number;
        overdueAr: number;
        depositsCollected: number;
      }[]
    >`
      select project_id,
        coalesce(sum(case when kind = 'credit_memo' then -total else total end), 0)::float8 as invoiced,
        coalesce(sum(case when kind = 'credit_memo' then 0 else amount_paid end), 0)::float8 as collected,
        coalesce(sum(balance) filter (where status in ('sent', 'partially_paid', 'overdue') and kind <> 'credit_memo'), 0)::float8 as ar_balance,
        coalesce(sum(balance) filter (where status in ('sent', 'partially_paid', 'overdue') and kind <> 'credit_memo' and due_date < current_date), 0)::float8 as overdue_ar,
        coalesce(sum(amount_paid) filter (where kind = 'deposit'), 0)::float8 as deposits_collected
      from finance.invoices where status not in ('draft', 'void') ${filter('project_id')}
      group by project_id`,
    tx<{ projectId: string; apBilled: number; apPaid: number; apOpen: number }[]>`
      select project_id,
        coalesce(sum(amount), 0)::float8 as ap_billed,
        coalesce(sum(amount_paid), 0)::float8 as ap_paid,
        coalesce(sum(balance), 0)::float8 as ap_open
      from finance.vendor_bills where status <> 'void' ${filter('project_id')}
      group by project_id`,
  ]);
  const out = new Map<string, LedgerTotals>();
  const get = (id: string) => {
    let t = out.get(id);
    if (!t) {
      t = {
        invoiced: 0,
        collected: 0,
        arBalance: 0,
        overdueAr: 0,
        apBilled: 0,
        apPaid: 0,
        apOpen: 0,
        depositsCollected: 0,
      };
      out.set(id, t);
    }
    return t;
  };
  for (const r of ar)
    Object.assign(get(r.projectId), {
      invoiced: round2(r.invoiced),
      collected: round2(r.collected),
      arBalance: round2(r.arBalance),
      overdueAr: round2(r.overdueAr),
      depositsCollected: round2(r.depositsCollected),
    });
  for (const r of ap)
    Object.assign(get(r.projectId), {
      apBilled: round2(r.apBilled),
      apPaid: round2(r.apPaid),
      apOpen: round2(r.apOpen),
    });
  return out;
}

export const contractFromQuotes = (quotes: QuoteSummary[]) => {
  const signed = quotes.filter((q) => CONTRACT_STATUSES.includes(q.status));
  return {
    contractValue: sum(signed.map((q) => q.sellTotal)),
    estimatedCost: sum(signed.map((q) => q.costTotal)),
  };
};

export const committedFromPos = (pos: PoSummary[]) =>
  sum(
    pos.filter((p) => !COMMITTED_PO_STATUSES_EXCLUDED.includes(p.status) && p.issuedAt).map((p) => p.total),
  );

const EMPTY_LEDGER: LedgerTotals = {
  invoiced: 0,
  collected: 0,
  arBalance: 0,
  overdueAr: 0,
  apBilled: 0,
  apPaid: 0,
  apOpen: 0,
  depositsCollected: 0,
};

/** Combine upstream (quotes, POs) with ledger totals into the per-project figures. */
function combine(
  l: LedgerTotals,
  contract: { contractValue: number; estimatedCost: number },
  committedCost: number,
) {
  const projected =
    contract.contractValue > 0 ? marginPct(contract.estimatedCost, contract.contractValue) : null;
  return {
    ...contract,
    committedCost,
    ...l,
    uninvoicedContract: round2(Math.max(0, contract.contractValue - l.invoiced)),
    projectedMarginPct: projected,
    actualMarginToDate: round2(l.collected - l.apPaid),
  };
}

async function upstreamFor(tenantId: string, projectId: string, warnings: string[]) {
  const [quotes, pos] = await Promise.all([
    tolerant(warnings, 'quoting', () => clients.quoteSummary(tenantId, projectId), [] as QuoteSummary[]),
    tolerant(warnings, 'orders', () => clients.poSummary(tenantId, projectId), [] as PoSummary[]),
  ]);
  return { contract: contractFromQuotes(quotes), committed: committedFromPos(pos) };
}

/** Run `fn` over items with bounded concurrency. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

export async function financialsRoutes(app: App) {
  app.get(
    '/projects/:projectId/financials',
    {
      schema: {
        tags: TAGS,
        summary: 'Project financials: contract, cost, commitments, AR/AP, margin and monthly cash flow',
        params: z.object({ projectId: z.uuid() }),
        response: { 200: ProjectFinancials },
      },
    },
    async (req) => {
      req.principal.require('finance:read');
      const { projectId } = req.params;
      const warnings: string[] = [];
      const upstream = await upstreamFor(req.principal.tenantId, projectId, warnings);
      const asOf = today();
      const months = lastMonths(asOf, 12);
      const from = `${months[0]}-01`;
      return req.tx(async (tx) => {
        const l = (await ledger(tx, [projectId])).get(projectId) ?? EMPTY_LEDGER;
        const [cashIn, cashOut] = await Promise.all([
          tx<{ month: string; amount: number }[]>`
            select to_char(p.received_at, 'YYYY-MM') as month, sum(p.amount)::float8 as amount
            from finance.payments p join finance.invoices i on i.id = p.invoice_id
            where i.project_id = ${projectId} and p.received_at >= ${from}
            group by 1`,
          tx<{ month: string; amount: number }[]>`
            select to_char(p.paid_at, 'YYYY-MM') as month, sum(p.amount)::float8 as amount
            from finance.bill_payments p join finance.vendor_bills b on b.id = p.bill_id
            where b.project_id = ${projectId} and p.paid_at >= ${from}
            group by 1`,
        ]);
        const inBy = new Map(cashIn.map((r) => [r.month, round2(r.amount)]));
        const outBy = new Map(cashOut.map((r) => [r.month, round2(r.amount)]));
        return {
          projectId,
          ...combine(l, upstream.contract, upstream.committed),
          byMonth: months.map((m) => {
            const ci = inBy.get(m) ?? 0;
            const co = outBy.get(m) ?? 0;
            return { month: m, cashIn: ci, cashOut: co, net: round2(ci - co) };
          }),
          warnings: [...new Set(warnings)],
        };
      });
    },
  );

  app.get(
    '/financials/portfolio',
    {
      schema: {
        tags: TAGS,
        summary: 'Portfolio financials: per active project, totals, AR aging and AP due in the next 30 days',
        response: { 200: Portfolio },
      },
    },
    async (req) => {
      req.principal.require('finance:read');
      const tenantId = req.principal.tenantId;
      const warnings: string[] = [];
      const asOf = today();
      const base = await req.tx(async (tx) => {
        const [ids, openAr, apDue] = await Promise.all([
          tx<{ projectId: string; projectNumber: string; projectName: string }[]>`
            select project_id, max(project_number) as project_number, max(project_name) as project_name from (
              select project_id, project_number, project_name from finance.invoices
              union all select project_id, '' , '' from finance.vendor_bills
            ) x group by project_id`,
          tx<{ dueDate: string; balance: number }[]>`
            select due_date, balance from finance.invoices
            where status in ('sent', 'partially_paid', 'overdue') and kind <> 'credit_memo' and balance > 0`,
          tx<
            {
              id: string;
              number: string;
              vendorName: string;
              projectId: string;
              poNumber: string | null;
              dueDate: string;
              balance: number;
            }[]
          >`
            select id, number, vendor_name, project_id, po_number, due_date, balance from finance.vendor_bills
            where status in ('open', 'scheduled', 'partially_paid') and balance > 0 and due_date <= ${addDays(asOf, 30)}
            order by due_date, vendor_name`,
        ]);
        return { ids, openAr, apDue, ledger: await ledger(tx, null) };
      });

      const projectInfo = await tolerant(
        warnings,
        'projects',
        () =>
          clients.projects(
            tenantId,
            base.ids.map((p) => p.projectId),
          ),
        [],
      );
      const infoById = new Map(projectInfo.map((p) => [p.id, p]));
      const active = base.ids.filter((p) => {
        const s = infoById.get(p.projectId)?.status;
        return !s || s === 'active' || s === 'won';
      });
      const rows = await mapLimit(active, 6, async (p) => {
        const info = infoById.get(p.projectId);
        const up = await upstreamFor(tenantId, p.projectId, warnings);
        const c = combine(base.ledger.get(p.projectId) ?? EMPTY_LEDGER, up.contract, up.committed);
        return {
          projectId: p.projectId,
          projectNumber: info?.number ?? p.projectNumber,
          projectName: info?.name ?? p.projectName,
          status: info?.status ?? null,
          contractValue: c.contractValue,
          estimatedCost: c.estimatedCost,
          committedCost: c.committedCost,
          invoiced: c.invoiced,
          collected: c.collected,
          arBalance: c.arBalance,
          overdueAr: c.overdueAr,
          apBilled: c.apBilled,
          apPaid: c.apPaid,
          apOpen: c.apOpen,
          projectedMarginPct: c.projectedMarginPct,
          actualMarginToDate: c.actualMarginToDate,
        };
      });
      rows.sort((a, b) => a.projectNumber.localeCompare(b.projectNumber));
      const t = (k: keyof (typeof rows)[number]) => sum(rows.map((r) => r[k] as number));
      const contractValue = t('contractValue');
      const estimatedCost = t('estimatedCost');
      const aging = emptyAging();
      for (const r of base.openAr)
        aging[agingBucket(r.dueDate, asOf)] = round2(aging[agingBucket(r.dueDate, asOf)] + r.balance);
      return {
        asOf,
        rows,
        totals: {
          contractValue,
          estimatedCost,
          committedCost: t('committedCost'),
          invoiced: t('invoiced'),
          collected: t('collected'),
          arBalance: t('arBalance'),
          overdueAr: t('overdueAr'),
          apBilled: t('apBilled'),
          apPaid: t('apPaid'),
          apOpen: t('apOpen'),
          projectedMarginPct: contractValue > 0 ? marginPct(estimatedCost, contractValue) : null,
          actualMarginToDate: t('actualMarginToDate'),
        },
        arAging: aging,
        apDueNext30: {
          total: sum(base.apDue.map((b) => b.balance)),
          count: base.apDue.length,
          items: base.apDue,
        },
        warnings: [...new Set(warnings)],
      };
    },
  );
}
