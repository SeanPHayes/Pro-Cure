import type { AiJobKind } from '@procure/domain';
import { type App, notFound, type Principal, type Tx, unprocessable } from '@procure/platform';
import { insertJob, applyJob as runApply, scheduleJob } from '../engine.js';
import { applyBrandSpec } from '../features/brand-spec/index.js';
import { applyDrawingSplit } from '../features/drawing-split/index.js';
import type { JobRow } from '../features/types.js';
import { applyVendorQuote } from '../features/vendor-quote/index.js';
import {
  ApplyBody,
  BrandSpecBody,
  DrawingSplitBody,
  IdParams,
  InboxRouteBody,
  Job,
  JobPage,
  JobQuery,
  ReviewBody,
  RiskScoreBody,
  VendorQuoteBody,
} from '../schemas.js';

/** AI jobs are internal-workspace tools; vendor and client portal users never reach them. */
export const requireAi = (p: Principal) => {
  p.requireInternal();
  p.require('ai:use');
};

/** Vendor-quote outputs carry vendor costs: only users who may see costs get them. */
const canSee = (p: Principal, job: JobRow) =>
  job.kind !== 'vendor_quote_extract' || p.can('quotes:costs:read');

export const toJob = (p: Principal, row: JobRow & Record<string, any>) => {
  const visible = canSee(p, row);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    input: row.input ?? {},
    output: visible ? (row.output ?? null) : null,
    outputRedacted: !visible && row.output != null,
    review: visible ? (row.review ?? null) : null,
    error: row.error,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    pages: row.pages,
    durationMs: row.durationMs,
    attempts: row.attempts ?? 0,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    appliedAt: row.appliedAt,
    appliedByName: row.appliedByName,
    applyResult: visible ? (row.applyResult ?? null) : null,
    applyError: row.applyError ?? null,
    discardedAt: row.discardedAt ?? null,
    discardedByName: row.discardedByName ?? null,
    entityType: row.entityType,
    entityId: row.entityId,
  } as unknown as Job;
};

/** Small per-kind summary computed in SQL for list views (counts only — no cost data). */
const SUMMARY_SQL = `case kind
  when 'brand_spec_extract' then jsonb_build_object('items', jsonb_array_length(coalesce(output->'items', '[]')),
       'standard', output->'standard'->>'name', 'warnings', jsonb_array_length(coalesce(output->'warnings', '[]')))
  when 'vendor_quote_extract' then jsonb_build_object('matches', jsonb_array_length(coalesce(output->'matches', '[]')),
       'unmatched', jsonb_array_length(coalesce(output->'unmatchedLines', '[]')), 'costRequest', output->'costRequest'->>'number')
  when 'drawing_split' then jsonb_build_object('groups', jsonb_array_length(coalesce(output->'groups', '[]')),
       'unassignedPages', jsonb_array_length(coalesce(output->'unassignedPages', '[]')))
  when 'inbox_route' then jsonb_build_object('intent', output->>'intent', 'poNumber', output->'target'->>'poNumber',
       'confidence', output->'confidence', 'routed', output->'routed')
  when 'risk_score' then jsonb_build_object('scored', output->'shipmentsScored', 'counts', output->'counts')
  else '{}'::jsonb end`;

export async function jobRoutes(app: App) {
  const create = async (
    p: Principal,
    kind: AiJobKind,
    title: string,
    input: Record<string, unknown>,
    entity: { type: string; id: string } | null,
    idempotencyKey: string | undefined,
    tx: Tx,
  ) =>
    insertJob(tx, {
      tenantId: p.tenantId,
      kind,
      title,
      input,
      entityType: entity?.type ?? null,
      entityId: entity?.id ?? null,
      createdBy: p.userId,
      createdByName: p.name,
      idempotencyKey: idempotencyKey ?? null,
    });

  const respond = (p: Principal, reply: any, r: { job: JobRow; created: boolean }, log: any) => {
    if (r.created) scheduleJob(p.tenantId, r.job.id, log);
    return reply.status(r.created ? 202 : 200).send(toJob(p, r.job));
  };

  // ---------------------------------------------------------------- create
  app.post(
    '/jobs/brand-spec',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Extract structured spec items from a brand-standard PDF',
        description:
          'Creates a queued job and runs it asynchronously. Poll GET /jobs/:id until needs_review.',
        body: BrandSpecBody,
        response: { 200: Job, 202: Job },
      },
    },
    async (req, reply) => {
      requireAi(req.principal);
      const { idempotencyKey, ...input } = req.body;
      const r = await req.tx((tx) =>
        create(
          req.principal,
          'brand_spec_extract',
          `Brand standard extraction${input.standardName ? `: ${input.standardName}` : ''}`,
          input,
          input.standardId ? { type: 'brand_standard', id: input.standardId } : null,
          idempotencyKey,
          tx,
        ),
      );
      return respond(req.principal, reply, r, req.log);
    },
  );

  app.post(
    '/jobs/vendor-quote',
    {
      schema: {
        tags: ['jobs'],
        summary: "Extract a vendor's PDF quote and match it to an open cost request",
        body: VendorQuoteBody,
        response: { 200: Job, 202: Job },
      },
    },
    async (req, reply) => {
      requireAi(req.principal);
      req.principal.require('quotes:costs:read');
      const { idempotencyKey, ...input } = req.body;
      const r = await req.tx((tx) =>
        create(
          req.principal,
          'vendor_quote_extract',
          'Vendor quote extraction',
          input,
          { type: 'cost_request', id: input.costRequestId },
          idempotencyKey,
          tx,
        ),
      );
      return respond(req.principal, reply, r, req.log);
    },
  );

  app.post(
    '/jobs/drawing-split',
    {
      schema: {
        tags: ['jobs'],
        summary: "Split a vendor's drawing packet PDF into one drawing per spec",
        body: DrawingSplitBody,
        response: { 200: Job, 202: Job },
      },
    },
    async (req, reply) => {
      requireAi(req.principal);
      const { idempotencyKey, ...input } = req.body;
      const r = await req.tx((tx) =>
        create(
          req.principal,
          'drawing_split',
          'Drawing packet split',
          input,
          input.quoteId ? { type: 'quote', id: input.quoteId } : null,
          idempotencyKey,
          tx,
        ),
      );
      return respond(req.principal, reply, r, req.log);
    },
  );

  app.post(
    '/jobs/inbox-route',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Re-run inbox routing for an inbound vendor email',
        body: InboxRouteBody,
        response: { 200: Job, 202: Job },
      },
    },
    async (req, reply) => {
      requireAi(req.principal);
      req.principal.require('inbox:triage');
      const { idempotencyKey, ...input } = req.body;
      const r = await req.tx((tx) =>
        create(
          req.principal,
          'inbox_route',
          'Inbox routing (manual)',
          input,
          { type: 'inbound_email', id: input.inboundEmailId },
          idempotencyKey,
          tx,
        ),
      );
      return respond(req.principal, reply, r, req.log);
    },
  );

  app.post(
    '/jobs/risk-score',
    {
      schema: {
        tags: ['jobs', 'risk'],
        summary: "Score late-delivery risk for the tenant's open shipments now",
        body: RiskScoreBody,
        response: { 200: Job, 202: Job },
      },
    },
    async (req, reply) => {
      requireAi(req.principal);
      req.principal.require('orders:read');
      const r = await req.tx((tx) =>
        create(
          req.principal,
          'risk_score',
          'Shipment risk scoring (on demand)',
          {},
          null,
          req.body?.idempotencyKey,
          tx,
        ),
      );
      return respond(req.principal, reply, r, req.log);
    },
  );

  // ---------------------------------------------------------------- read
  app.get(
    '/jobs',
    {
      schema: { tags: ['jobs'], summary: 'List AI jobs', querystring: JobQuery, response: { 200: JobPage } },
    },
    async (req) => {
      requireAi(req.principal);
      const q = req.query;
      const statuses = q.status?.split(',').filter(Boolean) ?? [];
      return req.tx(async (tx) => {
        const where = tx`
          where true
          ${q.kind ? tx`and kind = ${q.kind}` : tx``}
          ${statuses.length ? tx`and status in ${tx(statuses)}` : tx``}
          ${q.entityType ? tx`and entity_type = ${q.entityType}` : tx``}
          ${q.entityId ? tx`and entity_id = ${q.entityId}` : tx``}`;
        const [{ total }] = (await tx`select count(*)::int as total from ai.jobs ${where}`) as unknown as [
          { total: number },
        ];
        const rows = await tx<any[]>`
          select id, kind, status, title, input, error, provider, model, input_tokens, output_tokens, pages, duration_ms,
                 attempts, created_by, created_by_name, created_at, started_at, completed_at, applied_at, applied_by_name,
                 apply_error, discarded_at, discarded_by_name, entity_type, entity_id, ${tx.unsafe(SUMMARY_SQL)} as summary
          from ai.jobs ${where}
          order by created_at desc, id
          limit ${q.limit} offset ${q.offset}`;
        return {
          items: rows.map((r) => {
            const { output, review, applyResult, outputRedacted, ...rest } = toJob(req.principal, {
              ...r,
              output: null,
            }) as any;
            return { ...rest, outputRedacted: false, summary: r.summary ?? {} };
          }),
          total,
          limit: q.limit,
          offset: q.offset,
        };
      });
    },
  );

  const load = async (tx: any, id: string): Promise<JobRow> => {
    const [row] = await tx`select * from ai.jobs where id = ${id}`;
    if (!row) throw notFound('AI job');
    return row as JobRow;
  };

  app.get(
    '/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Get an AI job with its full output',
        params: IdParams,
        response: { 200: Job },
      },
    },
    async (req) => {
      requireAi(req.principal);
      return toJob(req.principal, await req.tx((tx) => load(tx, req.params.id)));
    },
  );

  // ---------------------------------------------------------------- review / retry / discard
  app.post(
    '/jobs/:id/review',
    {
      schema: {
        tags: ['jobs'],
        summary: "Save the reviewer's per-item accept/reject decisions and edits",
        params: IdParams,
        body: ReviewBody,
        response: { 200: Job },
      },
    },
    async (req) => {
      requireAi(req.principal);
      return req.tx(async (tx) => {
        const job = await load(tx, req.params.id);
        if (!canSee(req.principal, job)) req.principal.require('quotes:costs:read');
        if (job.status !== 'needs_review')
          throw unprocessable(`Only jobs awaiting review can be edited (status: ${job.status})`);
        const listLen =
          job.kind === 'brand_spec_extract'
            ? (job.output?.items?.length ?? 0)
            : job.kind === 'vendor_quote_extract'
              ? (job.output?.matches?.length ?? 0)
              : Number.POSITIVE_INFINITY;
        for (const it of req.body.review.items ?? [])
          if (it.index >= listLen) throw unprocessable(`Review item index ${it.index} is out of range`);
        const [row] = await tx<JobRow[]>`
          update ai.jobs set review = ${tx.json({ ...req.body.review, reviewedBy: req.principal.name, reviewedAt: new Date().toISOString() } as never)}
          where id = ${job.id} returning *`;
        return toJob(req.principal, row!);
      });
    },
  );

  app.post(
    '/jobs/:id/retry',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Re-run a failed (or reviewed but unapplied) job',
        params: IdParams,
        response: { 200: Job },
      },
    },
    async (req) => {
      requireAi(req.principal);
      const row = await req.tx(async (tx) => {
        const job = await load(tx, req.params.id);
        if (!['failed', 'needs_review'].includes(job.status) || (job as any).discardedAt)
          throw unprocessable(`Only failed or unreviewed jobs can be retried (status: ${job.status})`);
        if (job.applyResult)
          throw unprocessable('This job was partially applied; finish applying it instead of re-running it');
        const [r] = await tx<JobRow[]>`
          update ai.jobs set status = 'queued', attempts = 0, error = null, output = null, review = null,
            started_at = null, completed_at = null, apply_error = null
          where id = ${job.id} and status in ('failed', 'needs_review') returning *`;
        if (!r) throw unprocessable('Job changed state; reload and try again');
        return r;
      });
      scheduleJob(req.principal.tenantId, row.id, req.log);
      return toJob(req.principal, row);
    },
  );

  app.post(
    '/jobs/:id/discard',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Discard a job result without applying it',
        params: IdParams,
        response: { 200: Job },
      },
    },
    async (req) => {
      requireAi(req.principal);
      return req.tx(async (tx) => {
        const job = await load(tx, req.params.id);
        if (job.status === 'applied') throw unprocessable('Applied jobs cannot be discarded');
        if (['queued', 'running'].includes(job.status))
          throw unprocessable('Wait for the job to finish before discarding it');
        const [r] = await tx<JobRow[]>`
          update ai.jobs set status = 'completed', discarded_at = now(), discarded_by_name = ${req.principal.name}
          where id = ${job.id} returning *`;
        return toJob(req.principal, r!);
      });
    },
  );

  // ---------------------------------------------------------------- apply
  app.post(
    '/jobs/:id/apply',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Apply a reviewed job to the target service',
        description: [
          'brand_spec_extract: {target: "catalog"|"specs", standardId?, itemIndexes?, edits?}. The catalog target',
          'upserts items (by code) into an EXISTING brand standard (standardId from the body or the job input);',
          'creating a new standard is a curator action in the catalog service. Requires catalog:contribute or specs:write.',
          'vendor_quote_extract: {matchIndexes?, edits?} → cost-request response (source ai_pdf). Requires quotes:write.',
          'drawing_split: {groups?} → one line_drawing PDF per group attached to the spec. Requires specs:write.',
          'Without explicit indexes, every item not rejected in the saved review is applied.',
        ].join(' '),
        params: IdParams,
        body: ApplyBody,
        response: { 200: Job },
      },
    },
    async (req) => {
      requireAi(req.principal);
      const p = req.principal;
      const b = req.body ?? {};
      // Check the target domain's write permission before taking the apply lease.
      const kind = (await req.tx((tx) => load(tx, req.params.id))).kind;
      if (kind === 'brand_spec_extract')
        p.require(b.target === 'catalog' ? 'catalog:contribute' : 'specs:write');
      else if (kind === 'vendor_quote_extract') p.require('quotes:write', 'quotes:costs:read');
      else if (kind === 'drawing_split') p.require('specs:write');
      const row = await runApply(p, req.params.id, async (job) => {
        switch (job.kind) {
          case 'brand_spec_extract':
            if (!b.target) throw unprocessable('target is required ("catalog" or "specs")');
            return applyBrandSpec(
              job,
              { target: b.target, standardId: b.standardId, itemIndexes: b.itemIndexes, edits: b.edits },
              p,
            );
          case 'vendor_quote_extract':
            return applyVendorQuote(job, { matchIndexes: b.matchIndexes, edits: b.edits }, p);
          case 'drawing_split':
            return applyDrawingSplit(job, { groups: b.groups }, p);
          default:
            throw unprocessable(`${job.kind} jobs are not applied through this endpoint`);
        }
      });
      return toJob(p, row);
    },
  );
}
