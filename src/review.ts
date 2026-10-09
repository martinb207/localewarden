import path from 'node:path';
import type { Config } from './config.js';
import { flatten, readText, type JsonValue } from './files.js';
import { parseReviewId, State } from './state.js';
import { hash } from './util.js';

export interface ReviewItem {
  id: string;
  lang: string;
  file: string;
  key: string;
  status: 'pending' | 'approved';
  reason: string;
  since: string;
  value?: string;
}

function currentValue(config: Config, lang: string, fileId: string, key: string): string | undefined {
  const text = readText(path.join(config.root, fileId.split('{lang}').join(lang)));
  if (text === null) return undefined;
  try {
    return flatten(JSON.parse(text) as JsonValue).get(key);
  } catch {
    return undefined;
  }
}

/** Hand-edited translations, pending first. */
export function listReview(config: Config, includeApproved = false): ReviewItem[] {
  const state = new State(path.join(config.root, config.stateDir));
  return Object.entries(state.review)
    .filter(([, entry]) => includeApproved || entry.status === 'pending')
    .map(([id, entry]) => {
      const { lang, file, key } = parseReviewId(id);
      return { id, lang, file: entry.file, key, status: entry.status, reason: entry.reason, since: entry.since, value: currentValue(config, lang, file, key) };
    })
    .sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'pending' ? -1 : 1));
}

/** "de:settings.title", "de:*" or "all". */
function matches(selector: string, lang: string, key: string): boolean {
  if (selector === 'all') return true;
  const colon = selector.indexOf(':');
  if (colon === -1) return false;
  const [wantLang, wantKey] = [selector.slice(0, colon), selector.slice(colon + 1)];
  return wantLang === lang && (wantKey === '*' || wantKey === key);
}

/**
 * approve: the hand edit is correct; it stays protected and the quality check skips it.
 * release: hand the string back to localewarden; the next run revises it from the source.
 * Returns the number of entries changed.
 */
export function updateReview(config: Config, action: 'approve' | 'release', selectors: string[]): number {
  const state = new State(path.join(config.root, config.stateDir));
  let changed = 0;
  for (const [id, entry] of Object.entries(state.review)) {
    const { lang, file, key } = parseReviewId(id);
    if (!selectors.some(selector => matches(selector, lang, key))) continue;
    if (action === 'approve') {
      const value = currentValue(config, lang, file, key);
      if (value === undefined) continue;
      state.review[id] = { ...entry, status: 'approved', valueHash: hash(value) };
    } else {
      delete state.review[id];
      state.invalidate(lang, file, key);
    }
    changed++;
  }
  if (changed > 0) state.save();
  return changed;
}
