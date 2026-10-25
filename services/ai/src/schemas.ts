import { AiJobKind, AiJobStatus, page } from '@procure/domain';
import { z } from '@procure/platform';

/** API contract for the ai service (zod → OpenAPI). */

export const Job = z.object({
  id: z.uuid(),
  kind: AiJobKind,
  status: AiJobStatus,
  title: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).nullable(),
  /** True when the output was withheld because the caller lacks permission to see costs. */
  outputRedacted: z.boolean(),
  review: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  pages: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  attempts: z.number().int(),
  createdBy: z.uuid().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  appliedAt: z.string().nullable(),
  appliedByName: z.string().nullable(),
  applyResult: z.record(z.string(), z.unknown()).nullable(),
  applyError: z.string().nullable(),
  discardedAt: z.string().nullable(),
  discardedByName: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.uuid().nullable(),
});
export type Job = z.infer<typeof Job>;

/** List rows omit the (possibly large) input/output payloads. */
export const JobSummary = Job.omit({ output: true, review: true, applyResult: true }).extend({
  summary: z.record(z.string(), z.unknown()),
});
export const JobPage = page(JobSummary);

export const JobQuery = z.object({
  kind: AiJobKind.optional(),
  status: z
    .string()
    .optional()
    .describe('Comma-separated statuses, e.g. "needs_review,failed"')
    .refine((s) => !s || s.split(',').every((x) => AiJobStatus.safeParse(x).success), 'invalid status'),
  entityType: z.string().max(40).optional(),
  entityId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const IdParams = z.object({ id: z.uuid() });

const idempotencyKey = z
  .string()
  .min(8)
  .max(200)
  .optional()
  .describe('Repeat-safe key; the same key returns the same job');

export const BrandSpecBody = z.object({
  documentId: z.uuid(),
  brandId: z.uuid().optional(),
  standardId: z.uuid().optional().describe('Existing catalog brand standard to apply into'),
  standardName: z.string().max(200).optional(),
  idempotencyKey,
});

export const VendorQuoteBody = z.object({
  documentId: z.uuid(),
  costRequestId: z.uuid(),
  idempotencyKey,
});

export const DrawingSplitBody = z
  .object({
    documentId: z.uuid(),
    quoteId: z.uuid().optional(),
    specIds: z.array(z.uuid()).min(1).max(500).optional(),
    idempotencyKey,
  })
  .refine((b) => !!b.quoteId !== !!b.specIds, { message: 'Provide exactly one of quoteId or specIds' });

export const InboxRouteBody = z.object({ inboundEmailId: z.uuid(), idempotencyKey });

export const RiskScoreBody = z.object({ idempotencyKey }).default({});

export const ReviewBody = z.object({
  review: z
    .object({
      items: z
        .array(
          z.object({
            index: z.number().int().min(0),
            accepted: z.boolean().optional(),
            edits: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .max(5000)
        .optional(),
      groups: z
        .array(
          z.object({
            specId: z.uuid(),
            pages: z.array(z.number().int().min(1)).min(1),
            name: z.string().optional(),
          }),
        )
        .max(500)
        .optional(),
      notes: z.string().max(5000).optional(),
    })
    .passthrough(),
});

const Edit = z.object({ index: z.number().int().min(0), set: z.record(z.string(), z.unknown()) });

/** One body for all kinds; fields that do not apply to the job's kind are rejected. */
export const ApplyBody = z
  .object({
    // brand_spec_extract
    target: z.enum(['catalog', 'specs']).optional(),
    standardId: z.uuid().optional(),
    itemIndexes: z.array(z.number().int().min(0)).optional(),
    // vendor_quote_extract
    matchIndexes: z.array(z.number().int().min(0)).optional(),
    // both
    edits: z.array(Edit).max(5000).optional(),
    // drawing_split
    groups: z
      .array(
        z.object({
          specId: z.uuid(),
          code: z.string().optional(),
          name: z.string().optional(),
          pages: z.array(z.number().int().min(1)).min(1),
        }),
      )
      .max(500)
      .optional(),
  })
  .default({});

export const Capabilities = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  mode: z.enum(['llm', 'heuristic']),
  label: z.string(),
  ocr: z.object({ provider: z.string(), scannedPages: z.boolean() }),
  features: z.array(
    z.object({
      kind: AiJobKind,
      name: z.string(),
      mode: z.enum(['llm', 'heuristic']),
      applyTarget: z.string().nullable(),
    }),
  ),
});

export const VendorPerformance = z.object({
  vendorId: z.uuid(),
  sampleSize: z.number().int(),
  onTimeRate: z.number().nullable(),
  meanSlipDays: z.number().nullable(),
  p90SlipDays: z.number().nullable(),
  stdSlipDays: z.number().nullable(),
  meanLeadTimeWeeks: z.number().nullable(),
  shipDateChangeRate: z.number().nullable(),
  raw: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
});
export const VendorPerformanceQuery = z.object({
  vendorId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const RiskSummary = z.object({
  run: z
    .object({
      id: z.uuid(),
      runAt: z.string(),
      shipmentsScored: z.number().int(),
      vendorsProfiled: z.number().int(),
      jobId: z.uuid().nullable(),
    })
    .nullable(),
  counts: z.object({
    none: z.number().int(),
    watch: z.number().int(),
    at_risk: z.number().int(),
    critical: z.number().int(),
  }),
  narrative: z.string().nullable(),
  top: z.array(
    z.object({
      shipmentId: z.string(),
      score: z.number(),
      level: z.string(),
      reasons: z.array(z.string()),
      label: z.string(),
      poId: z.string().nullable(),
      poNumber: z.string().nullable(),
      projectName: z.string().nullable(),
      vendorId: z.string(),
      vendorName: z.string().nullable(),
    }),
  ),
});
