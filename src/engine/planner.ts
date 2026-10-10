import path from 'node:path';
import type { Checker, Issue } from '../checks.js';
import { isFixable, isUnchangedProse, muchShorter } from '../checks.js';
import type { Config } from '../config.js';
import {
  flatten,
  isArbMetadata,
  missingPluralLeaves,
  parseDoc,
  pathPattern,
  readText,
  type JsonValue,
  type Leaf,
  type LocaleFile,
} from '../files.js';
import type { PromptItem } from '../prompt.js';
import type { Scope } from '../scope.js';
import { reviewId } from '../state.js';
import { hash } from '../util.js';
import type { LanguageSummary, RunContext } from './context.js';

/** A parsed source-language file. */
export interface SourceFile {
  file: LocaleFile;
  doc: JsonValue;
  text: string;
  leaves: Leaf[];
}

export interface Repair {
  key: string;
  source: string;
  issues: Issue[];
}

/** What to do with one file in one language. */
export interface Plan {
  file: LocaleFile;
  lang: string;
  counts: LanguageSummary;
  sourceDoc: JsonValue;
  sourceText: string;
  targetRel: string;
  targetFile: string;
  targetText: string | null;
  targetDoc: JsonValue | null;
  /** Current values by key, updated as translations come in. */
  values: Map<string, string>;
  /** Strings to translate (new) or revise (source changed). */
  work: PromptItem[];
  repairs: Repair[];
  removed: string[];
  pluralExtras: Leaf[];
  /**
   * Translations taken into `values` but not yet recorded in the state. They are recorded
   * only after the file was written, so a failed write is retried, not taken for a hand edit.
   */
  pending: { key: string; source: string; value: string }[];
}

/** Everything the planner needs about the group being translated. */
export interface GroupTools {
  config: Config;
  scope: Scope;
  checker: Checker;
}

const matchesAny = (patterns: RegExp[], file: LocaleFile, sourceLanguage: string): boolean =>
  patterns.some(re => re.test(file.id) || re.test(file.pathFor(sourceLanguage)));

/**
 * Decides, per string, whether to translate, revise, repair, adopt or protect it:
 *
 *   no translation yet                      -> translate
 *   translation exists, never seen          -> adopt (unless it is the source copied over)
 *   source changed since the last write     -> revise from the existing translation
 *   value differs from what we wrote        -> hand edit: protect, list for review
 *   --retranslate-all / --retranslate-files -> translate again (hand edits stay protected)
 *   --refresh-before DATE, written earlier  -> translate again
 *   --fix-flagged, check finds a problem    -> targeted repair (or revise if content is missing)
 *
 * Returns null when the target file cannot be used (outside the project, invalid JSON).
 */
export function planFile(ctx: RunContext, group: GroupTools, source: SourceFile, lang: string): Plan | null {
  const { config, scope, checker } = group;
  const { state, options, log } = ctx;
  const { file } = source;
  const counts = ctx.counts(lang);
  const pluralExtras = missingPluralLeaves(source.leaves, lang);
  const leaves = [...source.leaves, ...pluralExtras];
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
  const repairs: Repair[] = [];
  const forceFile = matchesAny((options.retranslateFiles ?? []).map(pathPattern), file, config.sourceLanguage);
  const item = (key: string, sourceText: string, extra: Partial<PromptItem> = {}): PromptItem => ({
    key,
    source: sourceText,
    maxLength: scope.maxLength(key),
    file: file.id,
    ...extra,
  });

  for (const { key, value: src } of leaves) {
    const cur = current.get(key);
    const entry = state.get(lang, file.id, key);
    const sourceHash = hash(src);
    if (src.trim() === '') {
      values.set(key, src);
      continue;
    }
    if (isArbMetadata(targetRel, key)) {
      // Flutter ARB: "@@locale" names the target language; other metadata is copied.
      values.set(key, key === '@@locale' ? lang : cur ?? src);
      continue;
    }
    if (scope.isLiteral(key, src)) {
      // Not text: keep a localized value someone set (e.g. a /de/ URL), else copy the source.
      if (cur === undefined || cur.trim() === '') values.set(key, src);
      continue;
    }
    const hasValue = cur !== undefined && cur.trim() !== '';

    if (hasValue) {
      const id = reviewId(lang, file.id, key);
      const review = state.review[id];
      const curHash = hash(cur);
      if (options.overwriteManual && (review || (entry && entry.value !== curHash))) {
        delete state.review[id];
        fresh.push(item(key, src));
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
        state.set(lang, file.id, key, src, cur, false);
        continue;
      }
      if (entry && entry.value !== curHash) {
        const sourceChanged = entry.source !== sourceHash;
        state.addReview(lang, file.id, key, sourceChanged ? 'source-changed' : 'manual-edit', cur);
        state.set(lang, file.id, key, src, cur, false);
        log.info(`[${lang}] ${key}: edited by hand; protected and listed for review`);
        counts.protected++;
        continue;
      }
    }

    const stale = options.refreshBefore !== undefined && hasValue && (!entry || entry.date === '' || entry.date < options.refreshBefore);
    if (!hasValue || options.retranslateAll || forceFile || stale) {
      fresh.push(item(key, src));
    } else if (!entry) {
      // First time localewarden sees this string: adopt an existing translation, unless
      // it is just the source text copied over.
      if (isUnchangedProse(src, cur, checker.placeholderRe)) fresh.push(item(key, src));
      else state.set(lang, file.id, key, src, cur, false);
    } else if (entry.source !== sourceHash) {
      revise.push(item(key, src, { previous: cur }));
    } else if (options.fixFlagged) {
      const failed = state.repairFailures[reviewId(lang, file.id, key)];
      if (failed?.valueHash === hash(cur)) continue; // this value could not be fixed before
      // Missing content needs more than a minimal correction: revise from the existing text.
      if (muchShorter(lang, src, cur)) {
        revise.push(item(key, src, { previous: cur, completing: true }));
      } else {
        const issues = checker.checkString(lang, key, src, cur, file.id).filter(isFixable);
        if (issues.length > 0) repairs.push({ key, source: src, issues });
      }
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
  return {
    file,
    lang,
    counts,
    sourceDoc: source.doc,
    sourceText: source.text,
    targetRel,
    targetFile,
    targetText,
    targetDoc,
    values,
    work,
    repairs,
    removed,
    pluralExtras,
    pending: [],
  };
}
