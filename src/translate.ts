import path from 'node:path';
import { Checker, FIXABLE_CHECKS, isUnchangedProse, muchShorter, type Issue } from './checks.js';
import type { Config } from './config.js';
import {
  buildTarget,
  detectFormat,
  findSourceFiles,
  isArbMetadata,
  missingPluralLeaves,
  setAt,
  flatten,
  parseDoc,
  readText,
  serializeDoc,
  stringLeaves,
  writeText,
  type JsonValue,
  type LocaleFile,
} from './files.js';
import { BudgetExceededError, Client, FatalModelError, OpenAICompatibleModel, type Model } from './llm.js';
import { batchPrompt, repairInstruction, singlePrompt, type PromptItem } from './prompt.js';
import { Scope } from './scope.js';
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

/** JSON with object keys sorted, to compare content regardless of key order and formatting. */
function canonical(value: JsonValue): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v
  );
}

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
  const scope = new Scope(config);
  const files = findSourceFiles(config.root, config.files, config.sourceLanguage).filter(file => !scope.isExcluded(file));
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
  async function translateItems(lang: string, items: PromptItem[]): Promise<Map<PromptItem, string>> {
    const results = new Map<PromptItem, string>();
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
        const long = checker.tooLong(item.key, text);
        if (long) log.warn(`[${lang}] ${item.key}: ${long}; written, shorten it by hand or run --fix-flagged`);
        else if (defect.soft) log.debug?.(`[${lang}] ${item.key}: ${defect.soft} (kept)`);
        results.set(item, text);
      }
    }
    return results;
  }

  interface SourceFile {
    file: LocaleFile;
    doc: JsonValue;
    text: string;
    leaves: ReturnType<typeof stringLeaves>;
  }

  /**
   * Decides what to do with one file in one language: what to translate, revise or repair,
   * what is protected and what was removed. Returns null when the file is skipped.
   */
  function planFile({ file, doc: sourceDoc, text: sourceText, leaves: sourceLeaves }: SourceFile, lang: string) {
      const counts = summary.languages[lang];
      const pluralExtras = missingPluralLeaves(sourceLeaves, lang);
      const leaves = [...sourceLeaves, ...pluralExtras];
      const sourceKeys = new Set(leaves.map(leaf => leaf.key));
      const targetRel = file.pathFor(lang);
      const targetFile = path.join(config.root, targetRel);
      if (!path.resolve(targetFile).startsWith(path.resolve(config.root) + path.sep)) {
        log.error(`${targetRel} is outside the project; skipped.`);
        return null;
      }
      const targetText = readText(targetFile);
      let targetDoc: JsonValue | null = null;
      if (targetText !== null) {
        try {
          targetDoc = parseDoc(targetRel, targetText);
        } catch (error) {
          log.error(`${targetRel} is not valid JSON (${(error as Error).message}); skipped. Fix it by hand.`);
          return null;
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
        if (isArbMetadata(targetRel, key)) {
          // Flutter ARB: "@@locale" names the target language; other metadata is copied.
          values.set(key, key === '@@locale' ? lang : cur ?? source);
          continue;
        }
        if (scope.isLiteral(key, source)) {
          // Not text: keep a localized value someone set (e.g. a /de/ URL), else copy the source.
          if (cur === undefined || cur.trim() === '') values.set(key, source);
          continue;
        }
        const hasValue = cur !== undefined && cur.trim() !== '';

        if (hasValue) {
          const id = reviewId(lang, file.id, key);
          const review = state.review[id];
          const curHash = hash(cur);
          if (options.overwriteManual && (review || (entry && entry.value !== curHash))) {
            delete state.review[id];
            fresh.push({ key, source, maxLength: scope.maxLength(key) });
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
          fresh.push({ key, source, maxLength: scope.maxLength(key) });
        } else if (!entry) {
          // First time localewarden sees this string: adopt an existing translation, unless
          // it is just the source text copied over.
          if (isUnchangedProse(source, cur, checker.placeholderRe)) fresh.push({ key, source, maxLength: scope.maxLength(key) });
          else state.set(lang, file.id, key, source, cur);
        } else if (entry.source !== sourceHash) {
          revise.push({ key, source, previous: cur, maxLength: scope.maxLength(key) });
        } else if (options.fixFlagged) {
          const issues = checker.checkString(lang, key, source, cur).filter(issue => FIXABLE_CHECKS.has(issue.check));
          const failed = state.repairFailures[reviewId(lang, file.id, key)];
          // Missing content needs more than a minimal correction: revise from the existing text.
          if (failed?.valueHash === hash(cur)) continue; // this value could not be fixed before
          if (muchShorter(lang, source, cur)) revise.push({ key, source, previous: cur, maxLength: scope.maxLength(key), completing: true });
          else if (issues.length > 0) repairs.push({ key, source, issues });
        }
      }

      // Strings removed from the source.
      const removed = [...current.keys()].filter(key => !sourceKeys.has(key));
      for (const key of new Set([...removed, ...state.keys(lang, file.id).filter(key => !sourceKeys.has(key))])) {
        state.delete(lang, file.id, key);
        delete state.review[reviewId(lang, file.id, key)];
      }

      const work = [...fresh, ...revise];
      if (work.length + repairs.length + removed.length > 0) {
        log.info(
          `[${lang}] ${targetRel}: ${fresh.length} new, ${revise.length} changed${repairs.length ? `, ${repairs.length} to repair` : ''}${removed.length ? `, ${removed.length} to remove` : ''}`
        );
      }
      return { file, lang, counts, sourceDoc, sourceText, targetRel, targetFile, targetText, targetDoc, values, work, repairs, removed, pluralExtras };
  }

  type Plan = NonNullable<ReturnType<typeof planFile>>;

  /** Applies translations, runs repairs and writes the target file. */
  async function finishPlan(plan: Plan, translated: Map<PromptItem, string>): Promise<void> {
      const { file, lang, counts, sourceDoc, sourceText, targetRel, targetFile, targetText, targetDoc, values, work, repairs, removed, pluralExtras } = plan;
      if (work.length > 0) {
        for (const item of work) {
          const text = translated.get(item);
          if (text === undefined) {
            counts.failed++;
            continue;
          }
          if (item.completing && item.previous && muchShorter(lang, item.source, text)) {
            // Still missing content: keep the old text and do not spend tokens on it again.
            state.repairFailures[reviewId(lang, file.id, item.key)] = { valueHash: hash(item.previous), date: today(), problems: ['content missing'], reason: 'revision still much shorter than the source', attempted: text };
            log.warn(`[${lang}] ${item.key}: could not complete the missing content; listed in repair-failures.json`);
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
        const after = await translateOne(lang, { key, source, maxLength: scope.maxLength(key) }, repairInstruction(before, problems));
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
      // Same content as on disk (only formatting or key order differs): leave the file alone, so
      // projects formatted with Prettier do not get a diff on every run.
      const unchanged = targetDoc !== null && canonical(built) === canonical(targetDoc);
      const text = serializeDoc(targetRel, built, detectFormat(targetText ?? sourceText));
      if (!unchanged && text !== null && text !== targetText && !(targetText === null && Object.keys(built).length === 0)) {
        writeText(targetFile, text);
        summary.filesWritten.push(targetRel);
      }
  }

  const sources: SourceFile[] = [];
  for (const file of files) {
    const sourceRel = file.pathFor(config.sourceLanguage);
    const text = readText(path.join(config.root, sourceRel));
    if (text === null) continue;
    try {
      const doc = parseDoc(sourceRel, text);
      sources.push({ file, doc, text, leaves: stringLeaves(doc) });
    } catch (error) {
      log.error(`${sourceRel} is not valid JSON (${(error as Error).message}); skipped.`);
    }
  }

  try {
    // Per language: plan every file, translate all their strings in shared batches (many
    // small files, e.g. store listings, do not cost a request each), then write each file.
    await inParallel(languages, config.concurrency, async lang => {
      if (stopped()) return;
      const plans = sources.map(source => planFile(source, lang)).filter((plan): plan is Plan => plan !== null);
      const counts = summary.languages[lang];
      if (dryRun) {
        for (const plan of plans) {
          counts.planned += plan.work.length + plan.repairs.length;
          counts.plannedChars += [...plan.work, ...plan.repairs].reduce((sum, item) => sum + item.source.length, 0);
          counts.removed += plan.removed.length;
        }
        return;
      }
      const work = plans.flatMap(plan => plan.work);
      const translated = work.length > 0 ? await translateItems(lang, work) : new Map<PromptItem, string>();
      for (const plan of plans) await finishPlan(plan, translated);
      state.save();
    });
  } finally {
    if (!dryRun) state.save();
  }

  summary.tokens = client.tokens;
  summary.requests = client.requests;
  summary.pendingReview = Object.values(state.review).filter(entry => entry.status === 'pending').length;
  if (fatal) throw fatal;
  return summary;
}
