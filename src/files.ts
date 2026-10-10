import fs from 'node:fs';
import path from 'node:path';
import { escapeRegExp } from './util.js';

/** One source locale file and how to find its counterpart in another language. */
export interface LocaleFile {
  /** Stable id: the path pattern with {lang} kept, e.g. "locales/{lang}/common.json". */
  id: string;
  /** Path of the file in `lang`, relative to the project root (POSIX separators). */
  pathFor(lang: string): string;
}

type Token = { kind: 'lang' } | { kind: 'star' } | { kind: 'globstar' } | { kind: 'text'; text: string };

function tokenize(pattern: string): Token[] {
  return pattern
    .split(/(\{lang\}|\*\*\/|\*)/)
    .filter(part => part !== '')
    .map((part): Token => {
      if (part === '{lang}') return { kind: 'lang' };
      if (part === '**/') return { kind: 'globstar' };
      if (part === '*') return { kind: 'star' };
      return { kind: 'text', text: part };
    });
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.localewarden']);

/** Lists files below `dir`, following symbolic links once (a link loop is not followed again). */
function walk(root: string, dir: string, out: string[], seen = new Set<string>()): void {
  const full = path.join(root, dir);
  let real: string;
  try {
    real = fs.realpathSync(full);
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(full, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(path.join(root, rel));
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue; // broken link
      }
    }
    if (isDir) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, rel, out, seen);
    } else if (isFile) {
      out.push(rel);
    }
  }
}

/**
 * Finds the source-language files matching `pattern` under `root`.
 * Supported: {lang} (once or more), * within one path segment, and **\/ for any depth.
 */
export function findSourceFiles(root: string, pattern: string, sourceLanguage: string): LocaleFile[] {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const tokens = tokenize(normalized);
  const groups: ('lang' | 'wild')[] = [];
  let regex = '^';
  for (const token of tokens) {
    if (token.kind === 'lang') {
      if (groups.includes('lang')) {
        regex += '\\k<lang>';
      } else {
        regex += '(?<lang>[^/]+)';
        groups.push('lang');
      }
    } else if (token.kind === 'star') {
      regex += '([^/]*)';
      groups.push('wild');
    } else if (token.kind === 'globstar') {
      regex += '((?:[^/]+/)*)';
      groups.push('wild');
    } else {
      regex += escapeRegExp(token.text);
    }
  }
  const matcher = new RegExp(`${regex}$`);

  // Only walk below the static prefix of the pattern.
  const firstDynamic = normalized.search(/\{lang\}|\*/);
  const prefix = normalized.slice(0, firstDynamic);
  const baseDir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
  const all: string[] = [];
  walk(root, baseDir, all);

  const fill = (lang: string | null, wild: string[]): string => {
    let i = 0;
    return tokens
      .map(token => {
        if (token.kind === 'lang') return lang ?? '{lang}';
        if (token.kind === 'text') return token.text;
        return wild[i++];
      })
      .join('');
  };

  const files: LocaleFile[] = [];
  for (const rel of all.sort()) {
    if (!/\.(json|arb|txt)$/.test(rel)) continue;
    const match = matcher.exec(rel);
    if (!match || match.groups?.lang !== sourceLanguage) continue;
    const wild = groups
      .map((group, i) => (group === 'wild' ? match[i + 1] ?? '' : null))
      .filter((value): value is string => value !== null);
    files.push({ id: fill(null, wild), pathFor: lang => fill(lang, wild) });
  }
  return files;
}

/**
 * Key pattern -> RegExp. "*" matches within one segment, "**" any number of segments. A
 * pattern without a dot matches the last segment anywhere ("id" matches "steps.2.id").
 */
export function keyPattern(pattern: string): RegExp {
  const body = pattern
    .split(/(\*\*|\*)/)
    .map(part => (part === '**' ? '.*' : part === '*' ? '[^.]*' : escapeRegExp(part)))
    .join('');
  return new RegExp(pattern.includes('.') ? `^${body}$` : `(?:^|\\.)${body}$`);
}

/** Path pattern -> RegExp ("*" within a folder, "**" across folders, {lang} as written). */
export function pathPattern(pattern: string): RegExp {
  const body = pattern
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split(/(\*\*\/?|\*)/)
    .map(part => (part.startsWith('**') ? '(?:.*/)?' : part === '*' ? '[^/]*' : escapeRegExp(part)))
    .join('');
  return new RegExp(`^${body}$`);
}

/**
 * Values that are not text and stay as they are in every language: URLs, email addresses,
 * file paths and plain numbers or codes without spaces.
 */
export function isLiteralValue(value: string): boolean {
  const v = value.trim();
  return (
    /^(?:https?:\/\/|mailto:|tel:)\S+$/i.test(v) ||
    /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(v) ||
    /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:png|jpe?g|gif|svg|webp|avif|ico|mp3|mp4|webm|wav|pdf|json|css|js|html?)$/i.test(v) ||
    /^[\d\s.,:%+\-–/×x#]+$/.test(v)
  );
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type PathSegment = string | number;

/** A translatable string in a locale file. */
export interface Leaf {
  path: PathSegment[];
  /** Dotted key, e.g. "settings.title" or "steps.2". */
  key: string;
  value: string;
}

export const keyOf = (segments: PathSegment[]): string => segments.join('.');

/** All string values of a parsed JSON document, in document order. */
export function stringLeaves(value: JsonValue, prefix: PathSegment[] = [], out: Leaf[] = []): Leaf[] {
  if (typeof value === 'string') {
    out.push({ path: prefix, key: keyOf(prefix), value });
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => stringLeaves(item, [...prefix, i], out));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) stringLeaves(child, [...prefix, key], out);
  }
  return out;
}

/** Map of dotted key -> string value. */
export function flatten(value: JsonValue): Map<string, string> {
  return new Map(stringLeaves(value).map(leaf => [leaf.key, leaf.value]));
}

/**
 * Builds a target document with the shape and key order of `source`. String values come
 * from `values` (by dotted key); object keys without a value are left out so the app falls
 * back to the source language, array items without a value keep the source text so indices
 * stay aligned. Numbers, booleans and null are copied from the source.
 */
export function buildTarget(source: JsonValue, values: Map<string, string>, prefix: PathSegment[] = []): JsonValue | undefined {
  if (typeof source === 'string') return values.get(keyOf(prefix));
  if (Array.isArray(source)) {
    return source.map((item, i) => {
      const built = buildTarget(item, values, [...prefix, i]);
      return built === undefined ? item : built;
    });
  }
  if (source && typeof source === 'object') {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(source)) {
      const built = buildTarget(child, values, [...prefix, key]);
      if (built === undefined) continue;
      if (built && typeof built === 'object' && !Array.isArray(built) && Object.keys(built).length === 0) {
        continue;
      }
      // defineProperty: a key named "__proto__" stays a key instead of setting the prototype.
      Object.defineProperty(result, key, { value: built, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return source;
}

/**
 * i18next plural forms the target language needs but the source lacks. English has
 * "item_one" and "item_other"; Polish also needs "item_few" and "item_many", Arabic six forms.
 * Each missing form is translated from the source's "_other" text.
 */
export function missingPluralLeaves(leaves: Leaf[], lang: string): Leaf[] {
  let categories: string[];
  try {
    categories = new Intl.PluralRules(lang.replace('_', '-')).resolvedOptions().pluralCategories;
  } catch {
    return [];
  }
  const keys = new Set(leaves.map(leaf => leaf.key));
  const extra: Leaf[] = [];
  for (const leaf of leaves) {
    const last = leaf.path[leaf.path.length - 1];
    if (typeof last !== 'string' || !last.endsWith('_other')) continue;
    const stem = last.slice(0, -'_other'.length);
    const parent = leaf.path.slice(0, -1);
    for (const category of categories) {
      const segments = [...parent, `${stem}_${category}`];
      const key = keyOf(segments);
      if (!keys.has(key)) extra.push({ path: segments, key, value: leaf.value });
    }
  }
  return extra;
}

/** Sets `value` at `segments`, creating objects on the way. Only for object paths. */
export function setAt(doc: JsonValue, segments: PathSegment[], value: string): void {
  let node = doc as { [key: string]: JsonValue };
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment as string];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    node = next as { [key: string]: JsonValue };
  }
  const key = segments[segments.length - 1] as string;
  if (key in node) {
    node[key] = value;
    return;
  }
  // Insert after the last sibling with the same stem ("item_one", "item_other" -> "item_few").
  const stem = key.replace(/_[a-z]+$/, '_');
  const entries = Object.entries(node);
  const after = entries.map(([k]) => k.startsWith(stem)).lastIndexOf(true);
  entries.splice(after === -1 ? entries.length : after + 1, 0, [key, value]);
  for (const k of Object.keys(node)) delete node[k];
  Object.assign(node, Object.fromEntries(entries));
}

export interface JsonFormat {
  indent: string;
  finalNewline: boolean;
  /** Line ending of the existing file ("\r\n" on Windows checkouts). */
  eol: '\n' | '\r\n';
  /** The existing file starts with a byte order mark. */
  bom: boolean;
}

/** Indentation and final newline of an existing JSON text (2 spaces by default). */
/** Indentation, final newline, line ending and BOM of an existing text (2 spaces, LF by default). */
export function detectFormat(text: string | null): JsonFormat {
  const indent = text?.match(/^\uFEFF?[{[][ \t]*\r?\n([ \t]+)\S/)?.[1] ?? '  ';
  return {
    indent,
    finalNewline: text === null ? true : text.endsWith('\n'),
    eol: text?.includes('\r\n') ? '\r\n' : '\n',
    bom: text?.startsWith('\uFEFF') ?? false,
  };
}

/** Line endings, final newline and BOM applied to text written with "\n". */
function applyFormat(text: string, format: JsonFormat): string {
  const body = format.eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
  return (format.bom ? '\uFEFF' : '') + body + (format.finalNewline ? format.eol : '');
}

export function serialize(value: JsonValue, format: JsonFormat): string {
  // JSON.stringify escapes newlines inside strings, so every raw "\n" is structural.
  return applyFormat(JSON.stringify(value, null, format.indent), format);
}

const txtKey = (rel: string): string => path.posix.basename(rel.replace(/\\/g, '/'), '.txt');

/**
 * Parses a locale file. A .txt file (fastlane metadata: description.txt, keywords.txt) is one
 * string, keyed by its file name, so maxLength patterns like "keywords" apply to it.
 */
export function parseDoc(rel: string, text: string): JsonValue {
  const body = text.replace(/^\uFEFF/, '');
  if (rel.endsWith('.txt')) return { [txtKey(rel)]: body.replace(/\r?\n$/, '').replace(/\r\n/g, '\n') };
  return JSON.parse(body) as JsonValue;
}

/** Flutter ARB metadata ("@@locale", "@title": { description, placeholders }): not text. */
export const isArbMetadata = (rel: string, key: string): boolean => rel.endsWith('.arb') && key.startsWith('@');

/** Text of a locale file, or null when a .txt file has no value to write. */
export function serializeDoc(rel: string, doc: JsonValue, format: JsonFormat): string | null {
  if (!rel.endsWith('.txt')) return serialize(doc, format);
  const value = (doc as Record<string, JsonValue>)[txtKey(rel)];
  return typeof value === 'string' ? applyFormat(value, format) : null;
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Writes via a temporary file and a rename, so an interrupted run never leaves a half-written
 * locale file behind.
 */
export function writeText(file: string, text: string): void {
  // A symbolic link is written through (the link stays a link), with the file's own mode.
  let target = file;
  let mode: number | undefined;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o7777;
  } catch {
    // does not exist yet
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.localewarden-tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
