import { type AiJobKind, page } from '@procure/domain';
import { type App, config } from '@procure/platform';
import { currentLlm } from '../llm.js';
import { Capabilities, RiskSummary, VendorPerformance, VendorPerformanceQuery } from '../schemas.js';
import { requireAi } from './jobs.js';

const FEATURES: { kind: AiJobKind; name: string; applyTarget: string | null }[] = [
  {
    kind: 'brand_spec_extract',
    name: 'Brand standard PDF → spec items',
    applyTarget: 'catalog brand standard or spec library',
  },
  {
    kind: 'vendor_quote_extract',
    name: 'Vendor PDF quote → cost updates',
    applyTarget: 'cost request responses',
  },
  { kind: 'drawing_split', name: 'Drawing packet → per-spec line drawings', applyTarget: 'spec documents' },
  { kind: 'inbox_route', name: 'Inbox agent: route vendor emails to POs', applyTarget: null },
  { kind: 'risk_score', name: 'Lead-time & ship-date risk prediction', applyTarget: null },
];

const PROVIDER_LABEL: Record<string, string> = {
  bedrock: 'Claude via Bedrock',
  anthropic: 'Claude via Anthropic API',
};

export async function insightRoutes(app: App) {
  app.get(
    '/capabilities',
    {
      schema: {
        tags: ['capabilities'],
        summary: 'Which AI provider and OCR engine are active, and per-feature mode',
        response: { 200: Capabilities },
      },
    },
    async (req) => {
      requireAi(req.principal);
      const l = currentLlm();
      const mode = l.available ? ('llm' as const) : ('heuristic' as const);
      const ocr = config().OCR_PROVIDER;
      return {
        provider: l.available ? l.provider : 'heuristic',
        model: l.available ? l.model : null,
        mode,
        label: l.available
          ? `AI: ${PROVIDER_LABEL[l.provider] ?? l.provider}${l.model ? ` (${l.model})` : ''}`
          : 'Heuristic mode (no AI model configured)',
        ocr: {
          provider: ocr === 'textract' ? 'textract' : 'pdf-text-layer',
          scannedPages: ocr === 'textract',
        },
        features: FEATURES.map((f) => ({ ...f, mode })),
      };
    },
  );

  app.get(
    '/vendor-performance',
    {
      schema: {
        tags: ['risk'],
        summary: 'Vendor delivery performance (empirical-Bayes shrunk toward the tenant average)',
        querystring: VendorPerformanceQuery,
        response: { 200: page(VendorPerformance) },
      },
    },
    async (req) => {
      requireAi(req.principal);
      req.principal.require('vendors:read');
      const q = req.query;
      return req.tx(async (tx) => {
        const where = q.vendorId ? tx`where vendor_id = ${q.vendorId}` : tx``;
        const [{ total }] =
          (await tx`select count(*)::int as total from ai.vendor_performance ${where}`) as unknown as [
            { total: number },
          ];
        const items = await tx<any[]>`
          select vendor_id, sample_size, on_time_rate, mean_slip_days, p90_slip_days, std_slip_days, mean_lead_time_weeks,
                 ship_date_change_rate, raw, updated_at
          from ai.vendor_performance ${where}
          order by on_time_rate asc nulls last, vendor_id
          limit ${q.limit} offset ${q.offset}`;
        return { items, total, limit: q.limit, offset: q.offset };
      });
    },
  );

  app.get(
    '/risk/summary',
    {
      schema: {
        tags: ['risk'],
        summary: 'Shipment risk counts by level and the 10 riskiest shipments from the latest run',
        response: { 200: RiskSummary },
      },
    },
    async (req) => {
      requireAi(req.principal);
      req.principal.require('orders:read');
      return req.tx(async (tx) => {
        const [run] = await tx<any[]>`
          select id, run_at, shipments_scored, vendors_profiled, job_id, output
          from ai.risk_model_runs order by run_at desc limit 1`;
        if (!run)
          return {
            run: null,
            counts: { none: 0, watch: 0, at_risk: 0, critical: 0 },
            narrative: null,
            top: [],
          };
        const out = run.output ?? {};
        // postgres.js camel-cases JSON keys on read, so the stored "at_risk" count arrives as "atRisk".
        const rawCounts = (out.counts ?? {}) as Record<string, number>;
        const counts = {
          none: rawCounts.none ?? 0,
          watch: rawCounts.watch ?? 0,
          at_risk: rawCounts.at_risk ?? rawCounts.atRisk ?? 0,
          critical: rawCounts.critical ?? 0,
        };
        return {
          run: {
            id: run.id,
            runAt: run.runAt,
            shipmentsScored: run.shipmentsScored,
            vendorsProfiled: run.vendorsProfiled,
            jobId: run.jobId,
          },
          counts,
          narrative: out.narrative ?? null,
          top: ((out.top ?? []) as any[]).slice(0, 10).map((s) => ({
            shipmentId: s.shipmentId,
            score: s.score,
            level: s.level,
            reasons: s.reasons ?? [],
            label: s.label ?? s.shipmentId,
            poId: s.poId ?? null,
            poNumber: s.poNumber ?? null,
            projectName: s.projectName ?? null,
            vendorId: s.vendorId,
            vendorName: s.vendorName ?? null,
          })),
        };
      });
    },
  );
}
