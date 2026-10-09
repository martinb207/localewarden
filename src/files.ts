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

function walk(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, rel, out);
    } else if (entry.isFile()) {
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
    if (!rel.endsWith('.json')) continue;
    const match = matcher.exec(rel);
    if (!match || match.groups?.lang !== sourceLanguage) continue;
    const wild = groups
      .map((group, i) => (group === 'wild' ? match[i + 1] ?? '' : null))
      .filter((value): value is string => value !== null);
    files.push({ id: fill(null, wild), pathFor: lang => fill(lang, wild) });
  }
  return files;
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
      result[key] = built;
    }
    return result;
  }
  return source;
}

export interface JsonFormat {
  indent: string;
  finalNewline: boolean;
}

/** Indentation and final newline of an existing JSON text (2 spaces by default). */
export function detectFormat(text: string | null): JsonFormat {
  const indent = text?.match(/^[{[]\s*\n([ \t]+)\S/)?.[1] ?? '  ';
  return { indent, finalNewline: text === null ? true : text.endsWith('\n') };
}

export function serialize(value: JsonValue, format: JsonFormat): string {
  return JSON.stringify(value, null, format.indent) + (format.finalNewline ? '\n' : '');
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}
