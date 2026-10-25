import type { Meter } from '../llm.js';
import type { Logger } from '../logger.js';

/** A job row as stored in ai.jobs (camelCase). */
export interface JobRow {
  id: string;
  tenantId: string;
  kind: string;
  status: string;
  title: string;
  input: Record<string, any>;
  output: Record<string, any> | null;
  review: Record<string, any> | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  pages: number | null;
  durationMs: number | null;
  attempts: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  appliedAt: string | null;
  appliedByName: string | null;
  applyResult: Record<string, any> | null;
  entityType: string | null;
  entityId: string | null;
}

export interface FeatureContext {
  tenantId: string;
  job: JobRow;
  meter: Meter;
  log: Logger;
}

export interface FeatureResult {
  output: Record<string, unknown>;
  pages?: number | null;
  /** Final status; defaults to needs_review. */
  status?: 'needs_review' | 'completed';
  /** Update the job's entity link once known (e.g. inbox → purchase order). */
  entity?: { type: string; id: string } | null;
}

export type FeatureRunner = (ctx: FeatureContext) => Promise<FeatureResult>;
