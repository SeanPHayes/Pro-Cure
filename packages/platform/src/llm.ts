import Anthropic from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { z } from 'zod';
import { config } from './config.js';

/**
 * Large-language-model access. Bedrock (Claude) in AWS, the Anthropic API when a key is configured,
 * otherwise `local` — no model; callers fall back to deterministic heuristics so every AI feature
 * still works offline in the demo, with lower recall.
 *
 * All calls return JSON validated against a zod schema; one repair attempt is made on invalid output.
 */
export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface Llm {
  readonly provider: 'bedrock' | 'anthropic' | 'local';
  readonly model: string | null;
  readonly available: boolean;
  json<S extends z.ZodType>(req: LlmRequest, schema: S): Promise<{ data: z.infer<S>; usage: Usage }>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

const JSON_RULES = `
Respond with a single JSON value and nothing else — no prose, no markdown fences.
If a value is unknown, use null rather than guessing.`;

const extractJson = (text: string): unknown => {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const start = trimmed.search(/[[{]/);
  if (start < 0) throw new Error('model returned no JSON');
  return JSON.parse(trimmed.slice(start));
};

abstract class ClaudeBase implements Llm {
  abstract readonly provider: 'bedrock' | 'anthropic';
  abstract readonly model: string;
  readonly available = true;
  protected abstract complete(
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<{
    text: string;
    usage: Usage;
  }>;

  async json<S extends z.ZodType>(req: LlmRequest, schema: S) {
    const system = `${req.system}\n${JSON_RULES}`;
    const max = req.maxTokens ?? 8000;
    let { text, usage } = await this.complete(system, req.prompt, max);
    let parsed = schema.safeParse(safeJson(text));
    if (!parsed.success) {
      const retry = await this.complete(
        system,
        `${req.prompt}\n\nYour previous answer was invalid:\n${parsed.error.message.slice(0, 2000)}\nReturn corrected JSON only.`,
        max,
      );
      text = retry.text;
      usage = {
        inputTokens: usage.inputTokens + retry.usage.inputTokens,
        outputTokens: usage.outputTokens + retry.usage.outputTokens,
      };
      parsed = schema.safeParse(safeJson(text));
      if (!parsed.success)
        throw new Error(`model output failed validation: ${parsed.error.message.slice(0, 500)}`);
    }
    return { data: parsed.data as z.infer<S>, usage };
  }
}

const safeJson = (t: string) => {
  try {
    return extractJson(t);
  } catch {
    return undefined;
  }
};

class AnthropicLlm extends ClaudeBase {
  readonly provider = 'anthropic' as const;
  readonly model = config().AI_MODEL;
  private client = new Anthropic({ apiKey: config().ANTHROPIC_API_KEY });
  protected async complete(system: string, user: string, maxTokens: number) {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    return { text, usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
  }
}

class BedrockLlm extends ClaudeBase {
  readonly provider = 'bedrock' as const;
  readonly model = config().BEDROCK_MODEL_ID;
  private client = new BedrockRuntimeClient({ region: config().AWS_REGION });
  protected async complete(system: string, user: string, maxTokens: number) {
    const res = await this.client.send(
      new InvokeModelCommand({
        modelId: this.model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        }),
      }),
    );
    const out = JSON.parse(new TextDecoder().decode(res.body)) as {
      content: { type: string; text?: string }[];
      usage: { input_tokens: number; output_tokens: number };
    };
    return {
      text: out.content.map((c) => c.text ?? '').join(''),
      usage: { inputTokens: out.usage.input_tokens, outputTokens: out.usage.output_tokens },
    };
  }
}

class LocalLlm implements Llm {
  readonly provider = 'local' as const;
  readonly model = null;
  readonly available = false;
  async json(): Promise<never> {
    throw new Error('No LLM configured (AI_PROVIDER=local). Use the heuristic path.');
  }
}

let instance: Llm | undefined;
export const llm = (): Llm => {
  if (instance) return instance;
  const p = config().AI_PROVIDER;
  instance =
    p === 'bedrock'
      ? new BedrockLlm()
      : p === 'anthropic' && config().ANTHROPIC_API_KEY
        ? new AnthropicLlm()
        : new LocalLlm();
  return instance;
};
