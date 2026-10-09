import type { Config } from './config.js';
import { sleep } from './util.js';

export interface Completion {
  text: string;
  tokens: number;
}

/** Anything that turns a system + user message into text. Swap it out in tests. */
export interface Model {
  complete(system: string, user: string, options: { timeoutMs: number }): Promise<Completion>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
  }
}

/** Error that retrying cannot fix (bad key, unknown model, rejected parameter). */
export class FatalModelError extends ModelError {}

export const isReasoningModel = (model: string): boolean => /^(gpt-5|o\d)/.test(model);

/** Client for any OpenAI-compatible /chat/completions endpoint. */
export class OpenAICompatibleModel implements Model {
  private readonly apiKey: string;

  constructor(private readonly config: Config, apiKey = process.env[config.apiKeyEnv] ?? '') {
    this.apiKey = apiKey;
  }

  async complete(system: string, user: string, { timeoutMs }: { timeoutMs: number }): Promise<Completion> {
    const { model, temperature, reasoningEffort } = this.config;
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    // Reasoning models reject a custom temperature and take reasoning_effort instead.
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    else if (isReasoningModel(model)) body.reasoning_effort = 'medium';
    if (temperature !== undefined) body.temperature = temperature;
    else if (!isReasoningModel(model)) body.temperature = 0.3;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      throw new ModelError(name === 'TimeoutError' ? `no response within ${timeoutMs / 1000}s` : (error as Error).message);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let message = detail;
      try {
        message = JSON.parse(detail).error?.message ?? detail;
      } catch {
        // not JSON
      }
      const text = `HTTP ${response.status}: ${message.slice(0, 300)}`;
      if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 400) {
        throw new FatalModelError(text, response.status);
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ModelError(text, response.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new ModelError('response without message content');
    return { text: content.trim(), tokens: data.usage?.total_tokens ?? 0 };
  }
}

export class BudgetExceededError extends Error {}

/**
 * Wraps a Model with retries, spacing between requests and the per-run token budget.
 * The budget is checked before each request; the request that crosses it still completes.
 */
export class Client {
  tokens = 0;
  requests = 0;
  private lastStart = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly model: Model,
    private readonly maxTokens: number,
    private readonly options: { retries?: number; minSpacingMs?: number; onRetry?: (message: string) => void } = {}
  ) {}

  get budgetExceeded(): boolean {
    return this.tokens >= this.maxTokens;
  }

  /** Enforces a minimum gap between request starts across all parallel workers. */
  private spacing(): Promise<void> {
    const gap = this.options.minSpacingMs ?? 200;
    const turn = this.queue.then(async () => {
      const wait = this.lastStart + gap - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();
    });
    this.queue = turn;
    return turn;
  }

  async complete(system: string, user: string, timeoutMs: number): Promise<string> {
    const retries = this.options.retries ?? 3;
    for (let attempt = 1; ; attempt++) {
      if (this.budgetExceeded) throw new BudgetExceededError(`token budget of ${this.maxTokens.toLocaleString('en')} reached`);
      await this.spacing();
      try {
        this.requests++;
        const result = await this.model.complete(system, user, { timeoutMs });
        this.tokens += result.tokens;
        return result.text;
      } catch (error) {
        if (error instanceof FatalModelError || attempt > retries) throw error;
        const delay = (error as ModelError).retryAfterMs ?? Math.min(30_000, 2000 * 2 ** (attempt - 1));
        this.options.onRetry?.(`${(error as Error).message}; retry ${attempt}/${retries} in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
      }
    }
  }
}
