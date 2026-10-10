import type { Checker } from '../checks.js';
import { repairInstruction } from '../prompt.js';
import type { Scope } from '../scope.js';
import { reviewId } from '../state.js';
import { hash, today } from '../util.js';
import type { RunContext } from './context.js';
import type { Plan } from './planner.js';
import type { Translator } from './translator.js';

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

/**
 * Targeted repairs (--fix-flagged): the model gets the existing translation and the
 * findings, and must change only what fixes them. A repair is written only if the same
 * checks pass afterwards, nothing hard broke and few words changed; a rejected one is
 * recorded and not retried until the translation changes.
 */
export async function runRepairs(ctx: RunContext, plan: Plan, checker: Checker, scope: Scope, translator: Translator): Promise<void> {
  const { state, log } = ctx;
  const { lang, file, values, counts } = plan;
  for (const { key, source, issues } of plan.repairs) {
    if (ctx.stopped) break;
    const before = values.get(key) ?? '';
    const problems = issues.map(issue => (issue.note ? `${issue.check}: ${issue.note}` : issue.check));
    const after = await translator.translateOne(lang, { key, source, maxLength: scope.maxLength(key), file: file.id }, repairInstruction(before, problems));
    const id = reviewId(lang, file.id, key);
    let reason: string | null = after === null ? 'no answer' : null;
    if (after !== null) {
      const checks = new Set(issues.map(issue => issue.check));
      const remaining = checker.checkString(lang, key, source, after, file.id).filter(issue => checks.has(issue.check));
      reason =
        checker.defect(lang, key, source, after, file.id).hard ??
        (remaining.length > 0 ? `still flagged: ${remaining.map(r => r.note ?? r.check).join('; ')}` : null) ??
        tooManyChanges(before, after);
    }
    if (reason || after === null) {
      if (after !== null || !ctx.stopped) {
        state.repairFailures[id] = { valueHash: hash(before), date: today(), problems, reason: reason ?? 'no answer', ...(after ? { attempted: after } : {}) };
        log.warn(`[${lang}] ${key}: repair rejected (${reason})`);
      }
      continue;
    }
    delete state.repairFailures[id];
    values.set(key, after);
    plan.pending.push({ key, source, value: after });
    counts.repaired++;
  }
}
