import { muchShorter } from '../checks.js';
import { buildTarget, detectFormat, serializeDoc, setAt, writeText, type JsonValue } from '../files.js';
import type { PromptItem } from '../prompt.js';
import { reviewId } from '../state.js';
import { hash, today } from '../util.js';
import type { RunContext } from './context.js';
import type { Plan } from './planner.js';

/** JSON with object keys sorted, to compare content regardless of key order and formatting. */
export function canonical(value: JsonValue): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v
  );
}

/** Puts the translations that passed into the plan's values and records them in the state. */
export function applyTranslations(ctx: RunContext, plan: Plan, translated: Map<PromptItem, string>): void {
  const { state, log } = ctx;
  const { lang, file, values, counts } = plan;
  for (const item of plan.work) {
    const text = translated.get(item);
    if (text === undefined) {
      counts.failed++;
      continue;
    }
    if (item.completing && item.previous && muchShorter(lang, item.source, text)) {
      // Still missing content: keep the old text and do not spend tokens on it again.
      state.repairFailures[reviewId(lang, file.id, item.key)] = {
        valueHash: hash(item.previous),
        date: today(),
        problems: ['content missing'],
        reason: 'revision still much shorter than the source',
        attempted: text,
      };
      log.warn(`[${lang}] ${item.key}: could not complete the missing content; listed in repair-failures.json`);
      counts.failed++;
      continue;
    }
    values.set(item.key, text);
    plan.pending.push({ key: item.key, source: item.source, value: text });
    if (item.previous) counts.revised++;
    else counts.translated++;
  }
}

/**
 * Builds the target document in the source's shape and writes it, unless its content is the
 * same as on disk (formatting and key order of the existing file are then left alone).
 */
export function writePlan(ctx: RunContext, plan: Plan): void {
  const { targetRel, targetFile, targetText, targetDoc, values, sourceDoc, sourceText, pluralExtras } = plan;
  plan.counts.removed += plan.removed.length;
  const built = buildTarget(sourceDoc, values) ?? {};
  for (const leaf of pluralExtras) {
    const value = values.get(leaf.key);
    if (value !== undefined) setAt(built, leaf.path, value);
  }
  const unchanged = targetDoc !== null && canonical(built) === canonical(targetDoc);
  const text = serializeDoc(targetRel, built, detectFormat(targetText ?? sourceText));
  if (!unchanged && text !== null && text !== targetText && !(targetText === null && Object.keys(built).length === 0)) {
    writeText(targetFile, text);
    ctx.summary.filesWritten.push(targetRel);
  }
  // The file now holds these translations: record them (see Plan.pending).
  for (const { key, source, value } of plan.pending) ctx.state.set(plan.lang, plan.file.id, key, source, value);
  plan.pending = [];
}
