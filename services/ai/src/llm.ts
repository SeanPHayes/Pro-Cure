import type { z } from '@procure/platform';
import { type Llm, type LlmRequest, llm } from '@procure/platform';

/**
 * Indirection over the platform `llm()` so tests (and future per-tenant model routing) can inject a
 * provider. Every feature goes through `currentLlm()`; when `available` is false the feature uses its
 * deterministic heuristic path instead.
 */
let override: Llm | undefined;

export const currentLlm = (): Llm => override ?? llm();

/** Tests only. Pass `undefined` to restore the platform provider. */
export const setLlm = (l: Llm | undefined) => {
  override = l;
};

/** Accumulates provider / model / token usage across the LLM calls a job makes. */
export class Meter {
  provider: string;
  model: string | null;
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;
  constructor(l: Llm = currentLlm()) {
    this.provider = l.available ? l.provider : 'heuristic';
    this.model = l.available ? l.model : null;
  }
  /** Mark that the job fell back to (or only used) heuristics. */
  heuristic() {
    if (!this.calls) {
      this.provider = 'heuristic';
      this.model = null;
    }
  }
  async json<S extends z.ZodType>(req: LlmRequest, schema: S): Promise<z.infer<S>> {
    const l = currentLlm();
    const { data, usage } = await l.json(req, schema);
    this.calls++;
    this.provider = l.provider;
    this.model = l.model;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    return data;
  }
}
