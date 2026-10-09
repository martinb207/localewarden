import path from 'node:path';
import { Checker, FIXABLE_CHECKS, isUnchangedProse, type Issue } from './checks.js';
import type { Config } from './config.js';
import {
  buildTarget,
  detectFormat,
  findSourceFiles,
  missingPluralLeaves,
  setAt,
  flatten,
  readText,
  serialize,
  stringLeaves,
  writeText,
  type JsonValue,
  type LocaleFile,
} from './files.js';
import { BudgetExceededError, Client, FatalModelError, OpenAICompatibleModel, type Model } from './llm.js';
import { batchPrompt, repairInstruction, singlePrompt, type PromptItem } from './prompt.js';
import { reviewId, State } from './state.js';
import { baseLanguage, hash, inParallel, today } from './util.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export const consoleLogger: Logger = {
  info: message => console.log(message),
  warn: message => console.warn(`warning: ${message}`),
  error: message => console.error(`error: ${message}`),
};

export interface RunOptions {
  /** Subset of the configured target languages. */
  languages?: string[];
  /** Show what would be translated; no API calls, no writes. */
  dryRun?: boolean;
  /** Re-translate every string, not only new and changed ones. Hand edits stay protected. */
  retranslateAll?: boolean;
  /** Also replace hand-edited translations. */
  overwriteManual?: boolean;
  /** Ask the model to fix strings the quality check flags, changing as little as possible. */
  fixFlagged?: boolean;
  /** Overrides maxTokensPerRun from the config. */
  maxTokens?: number;
  logger?: Logger;
  /** Model to use instead of the configured OpenAI-compatible endpoint (tests, other SDKs). */
  model?: Model;
}

export interface LanguageSummary {
  translated: number;
  revised: number;
  repaired: number;
  failed: number;
  protected: number;
  removed: number;
  planned: number;
  plannedChars: number;
}

export interface RunSummary {
  languages: Record<string, LanguageSummary>;
  filesWritten: string[];
  tokens: number;
  requests: number;
  stoppedByBudget: boolean;
  pendingReview: number;
  dryRun: boolean;
}

// Scripts whose output costs many tokens per character; smaller batches avoid timeouts.
const SLOW_LANGUAGES = new Set(['ar', 'fa', 'ur', 'he', 'hi', 'mr', 'ne', 'bn', 'th', 'ta', 'te', 'kn', 'ml', 'gu', 'pa', 'si', 'my', 'km', 'lo', 'am', 'ka', 'hy']);
const MAX_BATCH_CHARS = 6000;

/** Words not shared by both texts, counted on the longer side (word-level LCS). */
export function changedWords(before: string, after: string): number {
  const split = (text: string) => text.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).map(w => w.toLocaleLowerCase());
  const a = split(before);
  const b = split(after);
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return Math.max(a.length, b.length) - prev[b.length];
}

/** A targeted repair may change a few words of a short string or a quarter of a long one. */
export function tooManyChanges(before: string, after: string): string | null {
  const changed = changedWords(before, after);
  const allowed = Math.max(6, Math.ceil(before.split(/\s+/).filter(Boolean).length * 0.25));
  return changed > allowed ? `changed ${changed} words (allowed ${allowed})` : null;
}

function parseArray(raw: string, expected: number): string[] | null {
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== expected) return null;
    return parsed.map(value => String(value));
  } catch {
    return null;
  }
}

const emptySummary = (): LanguageSummary => ({
  translated: 0,
  revised: 0,
  repaired: 0,
  failed: 0,
  protected: 0,
  removed: 0,
  planned: 0,
  plannedChars: 0,
});

export async function run(config: Config, options: RunOptions = {}): Promise<RunSummary> {
  const log = options.logger ?? consoleLogger;
  const languages = options.languages?.length ? options.languages : config.targetLanguages;
  const unknown = languages.filter(lang => !config.targetLanguages.includes(lang));
  if (unknown.length > 0) throw new Error(`Not in targetLanguages: ${unknown.join(', ')}`);

  if (config.context?.startsWith('Describe your product')) {
    log.warn('"context" still has the example text from init; it is ignored. Describe your product in localewarden.config.json for better translations.');
    config = { ...config, context: undefined };
  }
  const files = findSourceFiles(config.root, config.files, config.sourceLanguage);
  if (files.length === 0) {
    throw new Error(`No ${config.sourceLanguage} files match "${config.files}" under ${config.root}.`);
  }

  const dryRun = Boolean(options.dryRun);
  let model = options.model;
  if (!model && !dryRun) {
    if (!process.env[config.apiKeyEnv] && config.baseUrl.includes('api.openai.com')) {
      throw new Error(`Set the ${config.apiKeyEnv} environment variable to your OpenAI API key (or run with --dry-run).`);
    }
    model = new OpenAICompatibleModel(config);
  }
  const client = new Client(model ?? { complete: async () => ({ text: '', tokens: 0 }) }, options.maxTokens ?? config.maxTokensPerRun, {
    onRetry: message => log.warn(message),
  });
  const state = new State(path.join(config.root, config.stateDir));
  const checker = new Checker(config);
  const summary: RunSummary = {
    languages: Object.fromEntries(languages.map(lang => [lang, emptySummary()])),
    filesWritten: [],
    tokens: 0,
    requests: 0,
    stoppedByBudget: false,
    pendingReview: 0,
    dryRun,
  };
  let fatal: Error | null = null;
  const stopped = () => fatal !== null || summary.stoppedByBudget;

  const handleError = (error: unknown, lang: string): void => {
    if (error instanceof BudgetExceededError) {
      if (!summary.stoppedByBudget) log.warn(`${error.message}; stopping. Run again to continue.`);
      summary.stoppedByBudget = true;
    } else if (error instanceof FatalModelError) {
      fatal ??= error;
    } else {
      log.warn(`[${lang}] ${(error as Error).message}`);
    }
  };

  const timeoutFor = (lang: string) => (SLOW_LANGUAGES.has(baseLanguage(lang)) ? 240_000 : 120_000);

  async function translateOne(lang: string, item: PromptItem, extra = ''): Promise<string | null> {
    if (stopped()) return null;
    try {
      return (await client.complete(singlePrompt(config, lang, item, extra), item.source, timeoutFor(lang))).trim();
    } catch (error) {
      handleError(error, lang);
      return null;
    }
  }

  /** Translates items in batches; returns key -> translation for the ones that passed. */
  async function translateItems(lang: string, items: PromptItem[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const size = SLOW_LANGUAGES.has(baseLanguage(lang)) ? Math.min(5, config.batchSize) : config.batchSize;
    const batches: PromptItem[][] = [];
    let current: PromptItem[] = [];
    let chars = 0;
    for (const item of items) {
      // List markup gets split into several array elements by models; send it alone.
      const alone = /<li\b/i.test(item.source) || item.source.length > MAX_BATCH_CHARS / 2;
      if (current.length > 0 && (alone || current.length >= size || chars + item.source.length > MAX_BATCH_CHARS)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(item);
      chars += item.source.length;
      if (alone) {
        batches.push(current);
        current = [];
        chars = 0;
      }
    }
    if (current.length > 0) batches.push(current);

    for (const batch of batches) {
      if (stopped()) break;
      let candidates: (string | null)[] | null = null;
      if (batch.length > 1) {
        try {
          const raw = await client.complete(batchPrompt(config, lang, batch), JSON.stringify(batch.map(i => i.source)), timeoutFor(lang));
          candidates = parseArray(raw, batch.length);
          if (!candidates) log.warn(`[${lang}] batch answer was not a matching JSON array; translating one by one`);
        } catch (error) {
          handleError(error, lang);
          if (stopped()) break;
        }
      }
      if (!candidates) {
        candidates = [];
        for (const item of batch) candidates.push(await translateOne(lang, item));
      }

      for (const [i, item] of batch.entries()) {
        let text = candidates[i];
        if (text === null) continue;
        let defect = checker.defect(lang, item.key, item.source, text);
        const echoed = isUnchangedProse(item.source, text, checker.placeholderRe);
        if (defect.soft && (batch.length > 1 || echoed)) {
          // One retry on its own, then keep whichever version is cleaner.
          const retry = await translateOne(lang, item);
          if (retry !== null) {
            const retryDefect = checker.defect(lang, item.key, item.source, retry);
            const rank = (d: typeof defect) => (d.hard ? 2 : d.soft ? 1 : 0);
            if (rank(retryDefect) < rank(defect)) {
              text = retry;
              defect = retryDefect;
            } else if (echoed && isUnchangedProse(item.source, retry, checker.placeholderRe)) {
              // Asked twice, the model keeps the source text: names and product lists are often
              // the same in every language. Accept it instead of retrying on every run.
              defect = { hard: null, soft: 'identical to the source (accepted after a retry)' };
            }
          }
        }
        if (defect.hard) {
          log.warn(`[${lang}] ${item.key}: ${defect.hard}; not written`);
          continue;
        }
        if (defect.soft) log.debug?.(`[${lang}] ${item.key}: ${defect.soft} (kept)`);
        results.set(item.key, text);
      }
    }
    return results;
  }

  async function processFile(file: LocaleFile, sourceDoc: JsonValue, sourceText: string): Promise<void> {
    const sourceLeaves = stringLeaves(sourceDoc);

    await inParallel(languages, config.concurrency, async lang => {
      if (stopped()) return;
      const counts = summary.languages[lang];
      const pluralExtras = missingPluralLeaves(sourceLeaves, lang);
      const leaves = [...sourceLeaves, ...pluralExtras];
      const sourceKeys = new Set(leaves.map(leaf => leaf.key));
      const targetRel = file.pathFor(lang);
      const targetFile = path.join(config.root, targetRel);
      if (!path.resolve(targetFile).startsWith(path.resolve(config.root) + path.sep)) {
        log.error(`${targetRel} is outside the project; skipped.`);
        return;
      }
      const targetText = readText(targetFile);
      let targetDoc: JsonValue | null = null;
      if (targetText !== null) {
        try {
          targetDoc = JSON.parse(targetText) as JsonValue;
        } catch (error) {
          log.error(`${targetRel} is not valid JSON (${(error as Error).message}); skipped. Fix it by hand.`);
          return;
        }
      }
      const current = targetDoc === null ? new Map<string, string>() : flatten(targetDoc);
      const values = new Map(current);
      const fresh: PromptItem[] = [];
      const revise: PromptItem[] = [];
      const repairs: { key: string; source: string; issues: Issue[] }[] = [];

      for (const { key, value: source } of leaves) {
        const cur = current.get(key);
        const entry = state.get(lang, file.id, key);
        const sourceHash = hash(source);
        if (source.trim() === '') {
          values.set(key, source);
          continue;
        }
        const hasValue = cur !== undefined && cur.trim() !== '';

        if (hasValue) {
          const id = reviewId(lang, file.id, key);
          const review = state.review[id];
          const curHash = hash(cur);
          if (options.overwriteManual && (review || (entry && entry.value !== curHash))) {
            delete state.review[id];
            fresh.push({ key, source });
            continue;
          }
          if (review) {
            // Counted only when something new needs a person's attention, not on every run.
            if (review.status === 'approved' && review.valueHash !== curHash) {
              state.addReview(lang, file.id, key, 'edited-after-approval', cur);
              counts.protected++;
            } else if (entry && entry.source !== sourceHash) {
              state.addReview(lang, file.id, key, 'source-changed', cur);
              log.warn(`[${lang}] ${key}: source changed, but the translation was edited by hand; kept and listed for review`);
              counts.protected++;
            }
            state.set(lang, file.id, key, source, cur);
            continue;
          }
          if (entry && entry.value !== curHash) {
            const sourceChanged = entry.source !== sourceHash;
            state.addReview(lang, file.id, key, sourceChanged ? 'source-changed' : 'manual-edit', cur);
            state.set(lang, file.id, key, source, cur);
            log.info(`[${lang}] ${key}: edited by hand; protected and listed for review`);
            counts.protected++;
            continue;
          }
        }

        if (!hasValue || options.retranslateAll) {
          fresh.push({ key, source });
        } else if (!entry) {
          // First time localewarden sees this string: adopt an existing translation, unless
          // it is just the source text copied over.
          if (isUnchangedProse(source, cur, checker.placeholderRe)) fresh.push({ key, source });
          else state.set(lang, file.id, key, source, cur);
        } else if (entry.source !== sourceHash) {
          revise.push({ key, source, previous: cur });
        } else if (options.fixFlagged) {
          const issues = checker.checkString(lang, key, source, cur).filter(issue => FIXABLE_CHECKS.has(issue.check));
          const failed = state.repairFailures[reviewId(lang, file.id, key)];
          if (issues.length > 0 && failed?.valueHash !== hash(cur)) repairs.push({ key, source, issues });
        }
      }

      // Strings removed from the source.
      const removed = [...current.keys()].filter(key => !sourceKeys.has(key));
      for (const key of new Set([...removed, ...state.keys(lang, file.id).filter(key => !sourceKeys.has(key))])) {
        state.delete(lang, file.id, key);
        delete state.review[reviewId(lang, file.id, key)];
      }

      const work = [...fresh, ...revise];
      if (dryRun) {
        counts.planned += work.length + repairs.length;
        counts.plannedChars += [...work, ...repairs].reduce((sum, item) => sum + item.source.length, 0);
        counts.removed += removed.length;
        if (work.length + repairs.length + removed.length > 0) {
          log.info(
            `[${lang}] ${targetRel}: ${fresh.length} new, ${revise.length} changed${repairs.length ? `, ${repairs.length} to repair` : ''}${removed.length ? `, ${removed.length} to remove` : ''}`
          );
        }
        return;
      }

      if (work.length > 0) {
        log.info(`[${lang}] ${targetRel}: translating ${fresh.length} new, ${revise.length} changed`);
        const translated = await translateItems(lang, work);
        for (const item of work) {
          const text = translated.get(item.key);
          if (text === undefined) {
            counts.failed++;
            continue;
          }
          values.set(item.key, text);
          state.set(lang, file.id, item.key, item.source, text);
          if (item.previous) counts.revised++;
          else counts.translated++;
        }
      }

      for (const { key, source, issues } of repairs) {
        if (stopped()) break;
        const before = values.get(key) ?? '';
        const problems = issues.map(issue => (issue.note ? `${issue.check}: ${issue.note}` : issue.check));
        const after = await translateOne(lang, { key, source }, repairInstruction(before, problems));
        const id = reviewId(lang, file.id, key);
        let reason: string | null = after === null ? 'no answer' : null;
        if (after !== null) {
          const checks = new Set(issues.map(issue => issue.check));
          const remaining = checker.checkString(lang, key, source, after).filter(issue => checks.has(issue.check));
          reason =
            checker.defect(lang, key, source, after).hard ??
            (remaining.length > 0 ? `still flagged: ${remaining.map(r => r.note ?? r.check).join('; ')}` : null) ??
            tooManyChanges(before, after);
        }
        if (reason || after === null) {
          if (after !== null || !stopped()) {
            state.repairFailures[id] = { valueHash: hash(before), date: today(), problems, reason: reason ?? 'no answer', ...(after ? { attempted: after } : {}) };
            log.warn(`[${lang}] ${key}: repair rejected (${reason})`);
          }
          continue;
        }
        delete state.repairFailures[id];
        values.set(key, after);
        state.set(lang, file.id, key, source, after);
        counts.repaired++;
      }

      counts.removed += removed.length;
      const built = buildTarget(sourceDoc, values) ?? {};
      for (const leaf of pluralExtras) {
        const value = values.get(leaf.key);
        if (value !== undefined) setAt(built, leaf.path, value);
      }
      const text = serialize(built, detectFormat(targetText ?? sourceText));
      if (text !== targetText && !(targetText === null && Object.keys(built).length === 0)) {
        writeText(targetFile, text);
        summary.filesWritten.push(targetRel);
      }
    });
  }

  try {
    for (const file of files) {
      if (stopped()) break;
      const sourceRel = file.pathFor(config.sourceLanguage);
      const sourceText = readText(path.join(config.root, sourceRel));
      if (sourceText === null) continue;
      let sourceDoc: JsonValue;
      try {
        sourceDoc = JSON.parse(sourceText) as JsonValue;
      } catch (error) {
        log.error(`${sourceRel} is not valid JSON (${(error as Error).message}); skipped.`);
        continue;
      }
      await processFile(file, sourceDoc, sourceText);
      if (!dryRun) state.save();
    }
  } finally {
    if (!dryRun) state.save();
  }

  summary.tokens = client.tokens;
  summary.requests = client.requests;
  summary.pendingReview = Object.values(state.review).filter(entry => entry.status === 'pending').length;
  if (fatal) throw fatal;
  return summary;
}
