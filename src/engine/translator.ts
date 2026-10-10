import type { Checker } from '../checks.js';
import { isUnchangedProse } from '../checks.js';
import type { Config } from '../config.js';
import type { Client } from '../llm.js';
import { cleanOutput, parseArray, splitLongText } from '../output.js';
import { batchPrompt, singlePrompt, type PromptItem } from '../prompt.js';
import { baseLanguage } from '../util.js';
import type { RunContext } from './context.js';

// Scripts whose output costs many tokens per character; smaller batches avoid timeouts.
const SLOW_LANGUAGES = new Set(['ar', 'fa', 'ur', 'he', 'hi', 'mr', 'ne', 'bn', 'th', 'ta', 'te', 'kn', 'ml', 'gu', 'pa', 'si', 'my', 'km', 'lo', 'am', 'ka', 'hy']);
const MAX_BATCH_CHARS = 6000;

type Defect = { hard: string | null; soft: string | null };
const rank = (d: Defect) => (d.hard ? 2 : d.soft ? 1 : 0);

/**
 * Turns prompt items into checked translations: batches strings into JSON-array requests,
 * falls back to one request per string, splits very long texts at paragraph breaks, cleans
 * and post-processes answers, and retries a defective answer once on its own.
 */
export class Translator {
  constructor(
    private readonly ctx: RunContext,
    private readonly config: Config,
    private readonly checker: Checker,
    private readonly client: Client
  ) {}

  private timeoutFor(lang: string): number {
    return SLOW_LANGUAGES.has(baseLanguage(lang)) ? 240_000 : 120_000;
  }

  /** Model answer cleaned and run through plugin post-processing. */
  private finish(lang: string, item: PromptItem, raw: string): string {
    const text = cleanOutput(item.source, raw);
    return this.ctx.plugins.postProcess({ lang, key: item.key, file: item.file ?? '', source: item.source, text });
  }

  private notes(lang: string, items: PromptItem[]): string {
    return this.ctx.plugins.promptNotes(lang, items.map(i => ({ key: i.key, source: i.source })));
  }

  /** One string as plain text; very long new strings go paragraph by paragraph. */
  async translateOne(lang: string, item: PromptItem, extra = ''): Promise<string | null> {
    if (this.ctx.stopped) return null;
    const notes = this.notes(lang, [item]);
    try {
      if (!extra && !item.previous && item.source.length > this.config.chunkChars) {
        const { parts, separators } = splitLongText(item.source, this.config.chunkChars);
        let out = '';
        for (const [i, part] of parts.entries()) {
          const piece = await this.client.complete(singlePrompt(this.config, lang, { ...item, source: part }, notes), part, this.timeoutFor(lang));
          out += cleanOutput(part, piece) + (separators[i] ?? '');
        }
        return this.finish(lang, item, out);
      }
      const raw = await this.client.complete(singlePrompt(this.config, lang, item, extra + notes), item.source, this.timeoutFor(lang));
      return this.finish(lang, item, raw);
    } catch (error) {
      this.ctx.handleError(error, lang);
      return null;
    }
  }

  /** Splits items into batches by count and size; list markup and long texts go alone. */
  private batches(lang: string, items: PromptItem[]): PromptItem[][] {
    const size = SLOW_LANGUAGES.has(baseLanguage(lang)) ? Math.min(5, this.config.batchSize) : this.config.batchSize;
    const batches: PromptItem[][] = [];
    let current: PromptItem[] = [];
    let chars = 0;
    const flush = () => {
      if (current.length > 0) batches.push(current);
      current = [];
      chars = 0;
    };
    for (const item of items) {
      // Models split list markup into several array elements; send it alone.
      const alone = /<li\b/i.test(item.source) || item.source.length > MAX_BATCH_CHARS / 2;
      if (alone || current.length >= size || chars + item.source.length > MAX_BATCH_CHARS) flush();
      current.push(item);
      chars += item.source.length;
      if (alone) flush();
    }
    flush();
    return batches;
  }

  /** Translates items; returns the ones that passed the output checks. */
  async translateItems(lang: string, items: PromptItem[]): Promise<Map<PromptItem, string>> {
    const results = new Map<PromptItem, string>();
    for (const batch of this.batches(lang, items)) {
      if (this.ctx.stopped) break;
      let candidates: (string | null)[] | null = null;
      if (batch.length > 1) {
        try {
          const raw = await this.client.complete(
            batchPrompt(this.config, lang, batch, this.notes(lang, batch)),
            JSON.stringify(batch.map(i => i.source)),
            this.timeoutFor(lang)
          );
          const parsed = parseArray(raw, batch.length);
          candidates = parsed ? parsed.map((text, i) => (text === null ? null : this.finish(lang, batch[i], text))) : null;
          // An element the model left empty (null) gets its own request.
          if (candidates) for (const [i, text] of candidates.entries()) if (text === null) candidates[i] = await this.translateOne(lang, batch[i]);
          if (!candidates) this.ctx.log.warn(`[${lang}] batch answer was not a matching JSON array; translating one by one`);
        } catch (error) {
          this.ctx.handleError(error, lang);
          if (this.ctx.stopped) break;
        }
      }
      if (!candidates) {
        candidates = [];
        for (const item of batch) candidates.push(await this.translateOne(lang, item));
      }
      for (const [i, item] of batch.entries()) {
        const text = await this.accept(lang, item, candidates[i], batch.length > 1);
        if (text !== null) results.set(item, text);
      }
    }
    return results;
  }

  /** Output checks for one answer, with one retry on its own; null when it is not written. */
  private async accept(lang: string, item: PromptItem, candidate: string | null, fromBatch: boolean): Promise<string | null> {
    if (candidate === null) return null;
    let text = candidate;
    let defect: Defect = this.checker.defect(lang, item.key, item.source, text, item.file);
    const echoed = isUnchangedProse(item.source, text, this.checker.placeholderRe);
    if (defect.soft && (fromBatch || echoed)) {
      const retry = await this.translateOne(lang, item);
      if (retry !== null) {
        const retryDefect = this.checker.defect(lang, item.key, item.source, retry, item.file);
        if (rank(retryDefect) < rank(defect)) {
          text = retry;
          defect = retryDefect;
        } else if (echoed && isUnchangedProse(item.source, retry, this.checker.placeholderRe)) {
          // Asked twice, the model keeps the source text: names and product lists are often
          // the same in every language. Accept it instead of retrying on every run.
          defect = { hard: null, soft: 'identical to the source (accepted after a retry)' };
        }
      }
    }
    if (defect.hard) {
      this.ctx.log.warn(`[${lang}] ${item.key}: ${defect.hard}; not written`);
      return null;
    }
    const long = this.checker.tooLong(item.key, text);
    if (long) this.ctx.log.warn(`[${lang}] ${item.key}: ${long}; written, shorten it by hand or run --fix-flagged`);
    else if (defect.soft) this.ctx.log.debug?.(`[${lang}] ${item.key}: ${defect.soft} (kept)`);
    return text;
  }
}
