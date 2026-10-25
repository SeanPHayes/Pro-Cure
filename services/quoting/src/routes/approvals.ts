import { PageQuery } from '@procure/domain';
import { type App, conflict, forbidden, must, notFound, type Tx, unprocessable, z } from '@procure/platform';
import { catalog, tolerate } from '../clients.js';
import { type ApprovalCondition, type EvalLine, evaluatePolicies } from '../domain/approvals.js';
import { getQuote, pageResult, type ReqCtx, totalsFor } from '../repo.js';
import {
  ApprovalDecide,
  ApprovalListQuery,
  ApprovalPolicy,
  ApprovalPolicyInput,
  ApprovalPolicyPatch,
  ApprovalRequest,
  IdParams,
  pageOf,
  SubmitForApprovalResult,
} from '../schemas.js';

type AR = z.infer<typeof ApprovalRequest>;

const arSelect = (tx: Tx) => tx`a.*, q.number as quote_number, q.name as quote_name`;
const getApproval = async (tx: Tx, id: string) => {
  const [a] = await tx<AR[]>`
    select ${arSelect(tx)} from quoting.approval_requests a left join quoting.quotes q on q.id = a.entity_id
    where a.id = ${id}`;
  return must(a, 'Approval request');
};

const SUBMITTABLE = ['draft', 'costing', 'merchandising', 'pending_internal_approval', 'client_rejected'];

/**
 * Evaluate the tenant's active approval policies against a quote. With no failures the quote is
 * stamped internally approved; otherwise it moves to pending_internal_approval and one approval
 * request per failing policy is routed to the policy's approver role. Previous pending requests
 * are superseded (cancelled). Runs in its own transactions so the result is committed even when the
 * caller then refuses to proceed (send-to-client).
 */
export async function submitForApproval(req: ReqCtx, quoteId: string) {
  const p = req.principal;
  // 1) Load policies + lines (caller RLS).
  const { q, policies, lines, totals } = await req.tx(async (tx) => {
    const q = await getQuote(tx, quoteId);
    if (q.isTemplate) throw conflict('Templates are not approved');
    if (!SUBMITTABLE.includes(q.status))
      throw conflict(`A ${q.status} quote cannot be submitted for approval`);
    const policies = await tx<
      { id: string; name: string; condition: ApprovalCondition; approverRole: string }[]
    >`
      select id, name, condition, approver_role from quoting.approval_policies where active and applies_to = 'quote' order by name`;
    const lines = await tx<EvalLine[]>`
      select id, code, name, category, vendor_id, vendor_name, is_selected, margin_pct, flags
      from quoting.quote_lines where quote_id = ${q.id}`;
    return { q, policies, lines, totals: await totalsFor(tx, q) };
  });
  if (!lines.some((l) => l.isSelected)) throw unprocessable('The quote has no lines to approve');

  // 2) Vendor profiles (only when a vendor policy is active). Catalog outages → null (rule skipped with warning).
  const preferred = new Map<string, boolean | null>();
  if (policies.some((x) => x.condition.type === 'vendor_not_preferred')) {
    const ids = [...new Set(lines.filter((l) => l.isSelected && l.vendorId).map((l) => l.vendorId!))];
    for (const id of ids) {
      const v = await tolerate(() => catalog.vendor(p.tenantId, id));
      preferred.set(id, v?.profile ? Boolean(v.profile.preferred) : null);
    }
  }
  const result = evaluatePolicies(
    policies,
    { sellSubtotal: totals.sellSubtotal, grandTotal: totals.grandTotal, marginPct: totals.marginPct },
    lines,
    (id) => preferred.get(id) ?? null,
  );

  // 3) Persist outcome.
  return req.tx(async (tx) => {
    const locked = await getQuote(tx, q.id, { lock: true });
    if (locked.version !== q.version)
      throw conflict('The quote changed during approval evaluation; try again');
    await tx`update quoting.approval_requests set status = 'cancelled', comment = coalesce(comment, 'Superseded by resubmission')
             where entity_type = 'quote' and entity_id = ${q.id} and status = 'pending'`;
    const ids: string[] = [];
    for (const f of result.failures) {
      const [a] = await tx<{ id: string }[]>`
        insert into quoting.approval_requests ${tx({
          tenantId: p.tenantId,
          entityType: 'quote',
          entityId: q.id,
          policyId: f.policyId,
          policyName: f.policyName,
          reason: f.reason,
          details: tx.json(f.details as never),
          approverRole: f.approverRole,
          requestedBy: p.userId,
          requestedByName: p.name,
        } as never)} returning id`;
      ids.push(a!.id);
      await req.emit(tx, 'quoting.approval.requested', {
        approvalId: a!.id,
        entityType: 'quote',
        entityId: q.id,
        reason: f.reason,
        approverRole: f.approverRole,
      });
      await req.emit(tx, 'cmd.notify', {
        userIds: [],
        roles: [f.approverRole],
        title: `Approval needed: ${q.number} ${q.name}`,
        body: `${f.policyName}: ${f.reason}`,
        link: `/app/approvals`,
        severity: 'warning',
      });
    }
    const approved = ids.length === 0;
    await tx`update quoting.quotes set
        status = ${approved ? (locked.status === 'pending_internal_approval' || locked.status === 'client_rejected' || locked.status === 'draft' || locked.status === 'costing' ? 'merchandising' : locked.status) : 'pending_internal_approval'},
        submitted_for_approval_at = now(),
        internal_approved_at = ${approved ? tx`now()` : null}
      where id = ${q.id}`;
    const requests = ids.length
      ? await tx<
          AR[]
        >`select ${arSelect(tx)} from quoting.approval_requests a left join quoting.quotes q on q.id = a.entity_id
                       where a.id in ${tx(ids)} order by a.created_at`
      : [];
    const [{ status }] = (await tx`select status from quoting.quotes where id = ${q.id}`) as unknown as [
      { status: string },
    ];
    return { status: status as never, approved, requests, warnings: result.warnings };
  });
}

export async function approvalRoutes(app: App) {
  // ---------------------------------------------------------------- policies
  app.get(
    '/approval-policies',
    {
      schema: {
        tags: ['approvals'],
        summary: 'Approval policies (rules evaluated when a quote is submitted or sent to the client)',
        querystring: PageQuery.pick({ limit: true, offset: true }),
        response: { 200: pageOf(ApprovalPolicy) },
      },
    },
    async (req) => {
      req.principal.require('quotes:read');
      const { limit, offset } = req.query;
      return req.tx(async (tx) => {
        const [{ count }] =
          (await tx`select count(*)::int as count from quoting.approval_policies`) as unknown as [
            { count: number },
          ];
        const items =
          await tx`select * from quoting.approval_policies order by name limit ${limit} offset ${offset}`;
        return pageResult(items as unknown as never[], count, limit, offset);
      });
    },
  );

  app.post(
    '/approval-policies',
    {
      schema: {
        tags: ['approvals'],
        summary: 'Create an approval policy',
        body: ApprovalPolicyInput,
        response: { 201: ApprovalPolicy },
      },
    },
    async (req, reply) => {
      req.principal.require('approval_policies:write');
      const b = req.body;
      const r = await req.tx(async (tx) => {
        const [x] = await tx`
          insert into quoting.approval_policies (tenant_id, name, active, condition, approver_role, description)
          values (${req.principal.tenantId}, ${b.name}, ${b.active}, ${tx.json(b.condition as never)}, ${b.approverRole}, ${b.description ?? null})
          returning *`;
        return x!;
      });
      return reply.status(201).send(r as never);
    },
  );

  app.get(
    '/approval-policies/:id',
    {
      schema: {
        tags: ['approvals'],
        summary: 'An approval policy',
        params: IdParams,
        response: { 200: ApprovalPolicy },
      },
    },
    async (req) => {
      req.principal.require('quotes:read');
      return req.tx(async (tx) => {
        const [r] = await tx`select * from quoting.approval_policies where id = ${req.params.id}`;
        return must(r, 'Approval policy') as never;
      });
    },
  );

  app.patch(
    '/approval-policies/:id',
    {
      schema: {
        tags: ['approvals'],
        summary: 'Update an approval policy',
        params: IdParams,
        body: ApprovalPolicyPatch,
        response: { 200: ApprovalPolicy },
      },
    },
    async (req) => {
      req.principal.require('approval_policies:write');
      return req.tx(async (tx) => {
        const b = req.body;
        const sets: Record<string, unknown> = {};
        if (b.name !== undefined) sets.name = b.name;
        if (b.active !== undefined) sets.active = b.active;
        if (b.condition !== undefined) sets.condition = tx.json(b.condition as never);
        if (b.approverRole !== undefined) sets.approverRole = b.approverRole;
        if (b.description !== undefined) sets.description = b.description;
        const [r] = Object.keys(sets).length
          ? await tx`update quoting.approval_policies set ${tx(sets as never)} where id = ${req.params.id} returning *`
          : await tx`select * from quoting.approval_policies where id = ${req.params.id}`;
        return must(r, 'Approval policy') as never;
      });
    },
  );

  app.delete(
    '/approval-policies/:id',
    { schema: { tags: ['approvals'], summary: 'Delete an approval policy', params: IdParams } },
    async (req, reply) => {
      req.principal.require('approval_policies:write');
      await req.tx(async (tx) => {
        const [r] = await tx`delete from quoting.approval_policies where id = ${req.params.id} returning id`;
        must(r, 'Approval policy');
      });
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------- submit / decide
  app.post(
    '/quotes/:id/submit-for-approval',
    {
      schema: {
        tags: ['approvals'],
        summary:
          'Evaluate approval policies. Passing quotes are stamped approved; failures create approval requests routed to roles.',
        params: IdParams,
        response: { 200: SubmitForApprovalResult },
      },
    },
    async (req) => {
      const p = req.principal;
      if (!p.can('quotes:write') && !p.can('quotes:send')) p.require('quotes:write');
      return submitForApproval(req, req.params.id);
    },
  );

  app.get(
    '/approvals',
    {
      schema: {
        tags: ['approvals'],
        summary: 'Approval requests (mine=true → routed to one of my roles)',
        querystring: ApprovalListQuery,
        response: { 200: pageOf(ApprovalRequest) },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('quotes:read');
      const { status, quoteId, mine, limit, offset } = req.query;
      const roles = p.claims.roles as string[];
      return req.tx(async (tx) => {
        const where = tx`where true
          ${status ? tx`and a.status = ${status}` : tx``}
          ${quoteId ? tx`and a.entity_id = ${quoteId}` : tx``}
          ${mine && !roles.includes('admin') ? tx`and a.approver_role in ${tx(roles.length ? roles : ['-'])}` : tx``}`;
        const [{ count }] =
          (await tx`select count(*)::int as count from quoting.approval_requests a ${where}`) as unknown as [
            { count: number },
          ];
        const items = await tx<AR[]>`
          select ${arSelect(tx)} from quoting.approval_requests a left join quoting.quotes q on q.id = a.entity_id
          ${where} order by a.created_at desc limit ${limit} offset ${offset}`;
        return pageResult(items, count, limit, offset);
      });
    },
  );

  app.post(
    '/approvals/:id/decide',
    {
      schema: {
        tags: ['approvals'],
        summary:
          'Approve or reject an approval request (approver role or admin). All approved → quote leaves pending.',
        params: IdParams,
        body: ApprovalDecide,
        response: { 200: ApprovalRequest.extend({ quoteStatus: z.string(), quoteApproved: z.boolean() }) },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('approvals:decide');
      return req.tx(async (tx) => {
        const a = await getApproval(tx, req.params.id);
        const roles = p.claims.roles as string[];
        if (!roles.includes('admin') && !roles.includes(a.approverRole))
          throw forbidden(`This approval is routed to the ${a.approverRole} role`);
        if (a.status !== 'pending') throw conflict(`This approval is already ${a.status}`);
        if (a.requestedBy === p.userId && !roles.includes('admin'))
          throw forbidden('You cannot approve your own request');
        const q = await getQuote(tx, a.entityId, { lock: true });
        if (!q) throw notFound('Quote');
        await tx`update quoting.approval_requests set status = ${req.body.decision}, decided_by = ${p.userId},
                   decided_by_name = ${p.name}, decided_at = now(), comment = ${req.body.comment ?? null}
                 where id = ${a.id}`;
        await req.emit(tx, 'quoting.approval.decided', {
          approvalId: a.id,
          entityType: 'quote',
          entityId: q.id,
          status: req.body.decision,
        });
        let approved = false;
        if (req.body.decision === 'rejected') {
          await tx`update quoting.approval_requests set status = 'cancelled', comment = 'Another approval was rejected'
                   where entity_type = 'quote' and entity_id = ${q.id} and status = 'pending'`;
          await tx`update quoting.quotes set status = 'merchandising', internal_approved_at = null where id = ${q.id}`;
        } else {
          const [{ n }] = (await tx`select count(*)::int as n from quoting.approval_requests
                                    where entity_type = 'quote' and entity_id = ${q.id} and status = 'pending'`) as unknown as [
            { n: number },
          ];
          if (n === 0) {
            approved = true;
            await tx`update quoting.quotes set status = 'merchandising', internal_approved_at = now() where id = ${q.id}`;
          }
        }
        if (a.requestedBy)
          await req.emit(tx, 'cmd.notify', {
            userIds: [a.requestedBy],
            roles: [],
            title: `${q.number}: ${a.policyName} ${req.body.decision}`,
            body:
              req.body.comment ??
              (approved ? 'All approvals are in — the quote can be sent to the client.' : ''),
            link: `/app/quotes/${q.id}`,
            severity: req.body.decision === 'approved' ? 'success' : 'warning',
          });
        const [{ status }] = (await tx`select status from quoting.quotes where id = ${q.id}`) as unknown as [
          { status: string },
        ];
        return { ...(await getApproval(tx, a.id)), quoteStatus: status, quoteApproved: approved };
      });
    },
  );
}
