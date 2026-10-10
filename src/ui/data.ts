import fs from 'node:fs';
import path from 'node:path';
import { groupsOf, type Config } from '../config.js';
import { listFiles } from '../engine/sources.js';
import {
  detectFormat,
  flatten,
  isArbMetadata,
  parseDoc,
  readText,
  serializeDoc,
  stringLeaves,
  writeText,
  type JsonValue,
  type LocaleFile,
  type PathSegment,
} from '../files.js';
import { PluginHost } from '../plugins.js';
import { Scope } from '../scope.js';
import { reviewId, State } from '../state.js';
import { withLock } from '../lock.js';
import { hash, today } from '../util.js';

/** What the interface shows about one string. */
export interface StringRow {
  group?: string;
  file: string;
  key: string;
  source: string;
  text: string | null;
  status: 'missing' | 'translated' | 'pending-review' | 'approved' | 'not-text';
}

export interface GroupStatus {
  name?: string;
  files: number;
  sourceLanguage: string;
  languages: { lang: string; strings: number; translated: number; pendingReview: number }[];
}

const stateOf = (config: Config) => new State(path.join(config.root, config.stateDir));

const groupByName = (config: Config, name?: string): Config => {
  const groups = groupsOf(config);
  const group = name ? groups.find(g => g.name === name) : groups[0];
  if (!group) throw new Error(`Unknown group "${name}".`);
  return group;
};

const readFlat = (root: string, rel: string): Map<string, string> => {
  const text = readText(path.join(root, rel));
  if (text === null) return new Map();
  try {
    return flatten(parseDoc(rel, text));
  } catch {
    return new Map();
  }
};

function sourceStrings(group: Config, file: LocaleFile) {
  const rel = file.pathFor(group.sourceLanguage);
  const text = readText(path.join(group.root, rel));
  if (text === null) return [];
  try {
    return stringLeaves(parseDoc(rel, text));
  } catch {
    return [];
  }
}

/** Per group and language: strings, translated strings and hand edits waiting for review. */
export function status(config: Config, plugins: PluginHost): { groups: GroupStatus[]; usage: unknown; limits: unknown } {
  const state = stateOf(config);
  const pending = Object.entries(state.review).filter(([, e]) => e.status === 'pending').map(([id]) => id);
  const groups = groupsOf(config).map(group => {
    const scope = new Scope(group);
    const files = listFiles(group, scope, plugins);
    const languages = group.targetLanguages.map(lang => {
      let strings = 0;
      let translated = 0;
      for (const file of files) {
        const leaves = sourceStrings(group, file).filter(l => l.value.trim() !== '' && !scope.isLiteral(l.key, l.value));
        const target = readFlat(group.root, file.pathFor(lang));
        strings += leaves.length;
        translated += leaves.filter(l => (target.get(l.key) ?? '').trim() !== '').length;
      }
      const pendingReview = pending.filter(id => id.startsWith(`${lang}|`) && files.some(f => id.includes(`|${f.id}#`))).length;
      return { lang, strings, translated, pendingReview };
    });
    return { name: group.name, files: files.length, sourceLanguage: group.sourceLanguage, languages };
  });
  let usage: unknown = null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(config.root, config.stateDir, 'usage.json'), 'utf8'));
    // Usage is per UTC day: yesterday's numbers are not today's.
    usage = data?.date === today() ? data : { date: today(), tokens: 0, requests: 0 };
  } catch {
    // no usage recorded yet
  }
  return { groups, usage, limits: { maxTokensPerRun: config.maxTokensPerRun, dailyTokenBudget: config.dailyTokenBudget ?? null } };
}

/** Strings of a group in one language, filtered by a search text (key, source or translation). */
export function strings(
  config: Config,
  plugins: PluginHost,
  query: { group?: string; lang: string; q?: string; only?: 'missing' | 'pending-review'; limit?: number }
): { rows: StringRow[]; total: number } {
  const group = groupByName(config, query.group);
  if (!group.targetLanguages.includes(query.lang)) throw new Error(`"${query.lang}" is not a target language of this group.`);
  const scope = new Scope(group);
  const state = stateOf(config);
  const needle = query.q?.toLowerCase().trim();
  const rows: StringRow[] = [];
  for (const file of listFiles(group, scope, plugins)) {
    const target = readFlat(group.root, file.pathFor(query.lang));
    const targetRel = file.pathFor(query.lang);
    for (const leaf of sourceStrings(group, file)) {
      if (leaf.value.trim() === '') continue;
      const text = target.get(leaf.key) ?? null;
      const review = state.review[reviewId(query.lang, file.id, leaf.key)];
      const status: StringRow['status'] =
        isArbMetadata(targetRel, leaf.key) || scope.isLiteral(leaf.key, leaf.value)
          ? 'not-text'
          : text === null || text.trim() === ''
            ? 'missing'
            : review?.status === 'pending'
              ? 'pending-review'
              : review?.status === 'approved'
                ? 'approved'
                : 'translated';
      if (query.only && status !== query.only) continue;
      if (needle && ![leaf.key, leaf.value, text ?? ''].some(v => v.toLowerCase().includes(needle))) continue;
      rows.push({ group: group.name, file: file.id, key: leaf.key, source: leaf.value, text, status });
    }
  }
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
  return { rows: rows.slice(0, limit), total: rows.length };
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Sets one string in a target document. Missing objects are created empty; missing arrays
 * and array items are filled from the source document (as a run would), never with nulls.
 */
function setPath(doc: JsonValue, segments: PathSegment[], value: string, source: JsonValue): void {
  if (segments.some(s => typeof s === 'string' && UNSAFE_KEYS.has(s))) throw new Error('Unsupported key.');
  let node = doc as Record<string | number, JsonValue>;
  let src: JsonValue | undefined = source;
  for (const [i, segment] of segments.slice(0, -1).entries()) {
    const srcChild: JsonValue | undefined =
      src && typeof src === 'object' ? (src as Record<string | number, JsonValue>)[segment] : undefined;
    const current = node[segment];
    if (current === undefined || current === null || typeof current !== 'object') {
      node[segment] = Array.isArray(srcChild) ? structuredClone(srcChild) : typeof segments[i + 1] === 'number' ? [] : {};
    } else if (Array.isArray(current) && Array.isArray(srcChild)) {
      for (let j = 0; j < srcChild.length; j++) if (current[j] === undefined || current[j] === null) current[j] = structuredClone(srcChild[j]);
    }
    node = node[segment] as Record<string | number, JsonValue>;
    src = srcChild;
  }
  node[segments[segments.length - 1]] = value;
}

/**
 * Saves a translation edited in the interface. It counts as checked by a person: it is
 * approved on the review list, so runs leave it alone and the check skips its warnings.
 */
export function editString(
  config: Config,
  plugins: PluginHost,
  edit: { group?: string; lang: string; file: string; key: string; value: string }
): StringRow {
  const group = groupByName(config, edit.group);
  if (!group.targetLanguages.includes(edit.lang)) throw new Error(`"${edit.lang}" is not a target language of this group.`);
  if (typeof edit.value !== 'string') throw new Error('value must be a string.');
  // Only files of this group: the interface can never write anywhere else.
  const file = listFiles(group, new Scope(group), plugins).find(f => f.id === edit.file);
  if (!file) throw new Error(`Unknown file "${edit.file}".`);
  const leaf = sourceStrings(group, file).find(l => l.key === edit.key);
  if (!leaf) throw new Error(`Unknown key "${edit.key}".`);

  return withLock(path.join(config.root, config.stateDir), () => writeEdit(config, group, file, leaf, edit));
}

function writeEdit(
  config: Config,
  group: Config,
  file: LocaleFile,
  leaf: { path: PathSegment[]; value: string },
  edit: { lang: string; key: string; value: string }
): StringRow {
  const rel = file.pathFor(edit.lang);
  const full = path.join(group.root, rel);
  if (!path.resolve(full).startsWith(path.resolve(group.root) + path.sep)) throw new Error('Path outside the project.');
  const text = readText(full);
  const sourceText = readText(path.join(group.root, file.pathFor(group.sourceLanguage)));
  const sourceDoc: JsonValue = sourceText === null ? {} : parseDoc(file.pathFor(group.sourceLanguage), sourceText);
  const doc: JsonValue = text === null ? {} : parseDoc(rel, text);
  setPath(doc, leaf.path, edit.value, sourceDoc);
  const out = serializeDoc(rel, doc, detectFormat(text ?? sourceText));
  if (out !== null) writeText(full, out);

  const state = stateOf(config);
  state.set(edit.lang, file.id, edit.key, leaf.value, edit.value, false);
  state.review[reviewId(edit.lang, file.id, edit.key)] = {
    status: 'approved',
    reason: 'approved-by-hand',
    file: rel,
    since: today(),
    valueHash: hash(edit.value),
  };
  state.save();
  return { group: group.name, file: file.id, key: edit.key, source: leaf.value, text: edit.value, status: 'approved' };
}
