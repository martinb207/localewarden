import fs from 'node:fs';
import path from 'node:path';
import { writeText } from './files.js';
import { hash, sortObject, today } from './util.js';

/**
 * What localewarden remembers between runs, in <stateDir>/ (commit it with your locales):
 *
 * state.json   per language and string: hash of the source text it translated and hash of
 *              the value it wrote. Source hash differs -> the source changed, re-translate.
 *              Value hash differs -> a person edited the translation, protect it.
 * review.json  hand-edited translations. Pending entries wait for a person to look at them;
 *              approved ones stay protected and are skipped by the quality check.
 * repair-failures.json  targeted repairs (--fix-flagged) that were rejected, so the same
 *              value is not sent to the model again.
 */

export type ReviewReason = 'manual-edit' | 'source-changed' | 'edited-after-approval' | 'approved-by-hand';

export interface ReviewEntry {
  status: 'pending' | 'approved';
  reason: ReviewReason;
  file: string;
  since: string;
  valueHash: string;
}

export interface RepairFailure {
  valueHash: string;
  date: string;
  problems: string[];
  reason: string;
  attempted?: string;
}

interface StateFile {
  version: 1;
  languages: Record<string, Record<string, string>>;
}

/** "<file id>#<key>" */
export const stringId = (fileId: string, key: string): string => `${fileId}#${key}`;
/** "<lang>|<file id>#<key>" */
export const reviewId = (lang: string, fileId: string, key: string): string =>
  `${lang}|${stringId(fileId, key)}`;

export function parseReviewId(id: string): { lang: string; file: string; key: string } {
  // File ids are paths and contain no "#"; keys may ("faq.#1"), so split at the first one.
  const bar = id.indexOf('|');
  const hashMark = id.indexOf('#', bar + 1);
  return { lang: id.slice(0, bar), file: id.slice(bar + 1, hashMark), key: id.slice(hashMark + 1) };
}

function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T;
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON (${(error as Error).message}). It is localewarden's own bookkeeping: ` +
        'restore it from git, or delete it (translations are kept and adopted again; hand edits made since are then not detected).'
    );
  }
}

function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2) + '\n');
}

export class State {
  private readonly dir: string;
  private entries: Record<string, Record<string, string>>;
  review: Record<string, ReviewEntry>;
  repairFailures: Record<string, RepairFailure>;

  constructor(dir: string) {
    this.dir = dir;
    const state = readJson<StateFile>(path.join(dir, 'state.json'), { version: 1, languages: {} });
    this.entries = state.languages ?? {};
    this.review = readJson(path.join(dir, 'review.json'), {});
    this.repairFailures = readJson(path.join(dir, 'repair-failures.json'), {});
  }

  /**
   * Hashes recorded for a string, or undefined if localewarden has not seen it yet. `date` is
   * the UTC day (YYYY-MM-DD) localewarden wrote it; empty for adopted existing translations.
   */
  get(lang: string, fileId: string, key: string): { source: string; value: string; date: string } | undefined {
    const raw = this.entries[lang]?.[stringId(fileId, key)];
    if (!raw) return undefined;
    const [source, value, date = ''] = raw.split(':');
    return { source, value, date: date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : '' };
  }

  /**
   * Records that `value` is the current translation of `source`, written today; pass
   * `written: false` for a translation that was adopted or protected, not written by us.
   */
  set(lang: string, fileId: string, key: string, source: string, value: string, written = true): void {
    const id = stringId(fileId, key);
    const previous = this.get(lang, fileId, key);
    const keepDate = !written && previous && previous.value === hash(value) ? previous.date.replace(/-/g, '') : '';
    const date = written ? today().replace(/-/g, '') : keepDate;
    (this.entries[lang] ??= {})[id] = `${hash(source)}:${hash(value)}${date ? `:${date}` : ''}`;
  }

  /** Marks a recorded string as needing re-translation (source hash cleared). */
  invalidate(lang: string, fileId: string, key: string): void {
    const entry = this.get(lang, fileId, key);
    if (entry) this.entries[lang][stringId(fileId, key)] = `:${entry.value}`;
  }

  delete(lang: string, fileId: string, key: string): void {
    delete this.entries[lang]?.[stringId(fileId, key)];
  }

  /** Keys recorded for a file in a language. */
  keys(lang: string, fileId: string): string[] {
    const prefix = `${fileId}#`;
    return Object.keys(this.entries[lang] ?? {})
      .filter(id => id.startsWith(prefix))
      .map(id => id.slice(prefix.length));
  }

  addReview(lang: string, fileId: string, key: string, reason: ReviewReason, value: string): void {
    this.review[reviewId(lang, fileId, key)] = {
      status: 'pending',
      reason,
      file: fileId.replace('{lang}', lang),
      since: today(),
      valueHash: hash(value),
    };
  }

  save(): void {
    const languages = Object.fromEntries(
      Object.entries(this.entries)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([lang, entries]) => [lang, sortObject(entries)])
    );
    writeJson(path.join(this.dir, 'state.json'), { version: 1, languages });
    writeJson(path.join(this.dir, 'review.json'), sortObject(this.review));
    if (Object.keys(this.repairFailures).length > 0 || fs.existsSync(path.join(this.dir, 'repair-failures.json'))) {
      writeJson(path.join(this.dir, 'repair-failures.json'), sortObject(this.repairFailures));
    }
  }
}
