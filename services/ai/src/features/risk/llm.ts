import { z } from '@procure/platform';
import type { Meter } from '../../llm.js';

export interface PortfolioSummary {
  scored: number;
  counts: Record<string, number>;
  top: { label: string; score: number; level: string; reasons: string[] }[];
  worstVendors: { name: string; onTimeRate: number; meanSlipDays: number; sampleSize: number }[];
}

/** Deterministic narrative used offline (and as the fallback). */
export function heuristicNarrative(s: PortfolioSummary): string {
  const risky = (s.counts.at_risk ?? 0) + (s.counts.critical ?? 0);
  if (!s.scored) return 'No open shipments to score.';
  const first =
    `${risky} of ${s.scored} open shipment${s.scored === 1 ? '' : 's'} ${risky === 1 ? 'is' : 'are'} at risk or critical` +
    (s.counts.watch ? `, with ${s.counts.watch} more on watch.` : '.');
  const t = s.top[0];
  const second =
    t && t.level !== 'none'
      ? `Highest risk: ${t.label} (${t.score}/100) — ${t.reasons[0]?.replace(/\.$/, '').toLowerCase() ?? 'multiple factors'}.`
      : 'No shipment currently needs escalation.';
  return `${first} ${second}`;
}

const Narrative = z.object({ narrative: z.string().min(10).max(600) });

const SYSTEM = `You are the logistics lead at a hotel FF&E procurement firm writing a status line for the operations
dashboard. Write exactly two sentences, plain and specific: what share of open shipments is at risk and why
(the dominant drivers), and the single most important action for this week. No greetings, no markdown, no
invented facts — use only the numbers provided.`;

export async function llmNarrative(s: PortfolioSummary, meter: Meter): Promise<string> {
  const res = await meter.json(
    {
      system: SYSTEM,
      prompt: `Portfolio risk data:\n${JSON.stringify(s, null, 2)}\n\nReturn JSON: {"narrative": "..."}`,
      maxTokens: 400,
    },
    Narrative,
  );
  return res.narrative.trim();
}
