import path from 'node:path';
import { CHECKS, Checker, isError, type CheckName } from './checks.js';
import { groupsOf, selectGroups, type Config } from './config.js';
import { listFiles } from './engine/sources.js';
import { findSourceFiles, flatten, isArbMetadata, parseDoc, readText, writeText, type JsonValue } from './files.js';
import { PluginHost, type Plugin } from './plugins.js';
import { reviewId, State } from './state.js';
import { hash } from './util.js';

export interface Finding {
  lang: string;
  /** Built-in check name or a plugin's check name. */
  check: CheckName | (string & {});
  /** Group name, when the config has groups. */
  group?: string;
  severity: 'error' | 'warning';
  file: string;
  key: string;
  text: string;
  note?: string;
}

/**
 * Short sibling strings (same parent key) that differ in the source but got the same
 * translation: answer options, tabs or menu items the user can no longer tell apart.
 */
export function collapsedSiblings(source: Map<string, string>, target: Map<string, string>): { key: string; note: string }[] {
  const groups = new Map<string, string[]>();
  for (const key of target.keys()) {
    // Only nested keys: in a flat file every string would be a "sibling" of every other.
    if (!key.includes('.')) continue;
    const parent = key.slice(0, key.lastIndexOf('.'));
    // Plural forms of one string are meant to look alike.
    if (/_(zero|one|two|few|many|other)$/.test(key)) continue;
    groups.set(parent, [...(groups.get(parent) ?? []), key]);
  }
  const out: { key: string; note: string }[] = [];
  for (const keys of groups.values()) {
    const seen = new Map<string, string>();
    for (const key of keys) {
      const src = source.get(key)?.trim();
      const text = target.get(key)?.trim().toLocaleLowerCase();
      if (!src || !text || src.length > 40) continue;
      const earlier = seen.get(text);
      if (earlier !== undefined && source.get(earlier)?.trim().toLocaleLowerCase() !== src.toLocaleLowerCase()) {
        out.push({ key, note: `same translation as "${earlier}", although the source differs ("${source.get(earlier)}" / "${src}")` });
      } else if (earlier === undefined) {
        seen.set(text, key);
      }
    }
  }
  return out;
}

function readJson(file: string): JsonValue | null {
  const text = readText(file);
  return text === null ? null : parseDoc(file, text);
}

export interface CheckOptions {
  /** Subset of the target languages. */
  languages?: string[];
  /** Only these groups (by name). */
  groups?: string[];
  /** Loaded plugins (see loadPlugins); their checks run too. */
  plugins?: Plugin[];
}

/**
 * Runs the quality checks over every translated string of every group. Approved strings are
 * skipped except for errors (placeholder, unsafe, script, plugin errors), which break the
 * software either way.
 */
export function checkProject(config: Config, optionsOrLanguages: CheckOptions | string[] = {}): Finding[] {
  const options: CheckOptions = Array.isArray(optionsOrLanguages) ? { languages: optionsOrLanguages } : optionsOrLanguages;
  const host = new PluginHost(options.plugins ?? []);
  const state = new State(path.join(config.root, config.stateDir));
  const findings: Finding[] = [];
  for (const group of selectGroups(config, options.groups, options.languages)) {
    const checker = new Checker(group, host);
    const languages = group.targetLanguages.filter(lang => !options.languages?.length || options.languages.includes(lang));
    for (const file of listFiles(group, checker.scope, host)) {
      const sourceDoc = readJson(path.join(group.root, file.pathFor(group.sourceLanguage)));
      if (sourceDoc === null) continue;
      const source = flatten(sourceDoc);
      for (const lang of languages) {
        const rel = file.pathFor(lang);
        let doc: JsonValue | null;
        try {
          doc = readJson(path.join(group.root, rel));
        } catch (error) {
          findings.push({ lang, check: 'markup', severity: 'error', file: rel, key: '(file)', text: '', note: `invalid JSON: ${(error as Error).message}`, group: group.name });
          continue;
        }
        if (doc === null) continue;
        const translated = flatten(doc);
        for (const { key, note } of collapsedSiblings(source, translated)) {
          const review = state.review[reviewId(lang, file.id, key)];
          if (review?.status === 'approved') continue;
          findings.push({ lang, check: 'partial', severity: 'warning', file: rel, key, text: translated.get(key) ?? '', note, group: group.name });
        }
        for (const [key, text] of translated) {
          // Plural forms only the target language has are checked against the source "_other".
          const sourceText = source.get(key) ?? (/_(zero|one|two|few|many)$/.test(key) ? source.get(key.replace(/_(zero|one|two|few|many)$/, '_other')) : undefined);
          if (sourceText === undefined || sourceText.trim() === '' || isArbMetadata(rel, key) || checker.scope.isLiteral(key, sourceText)) continue;
          const review = state.review[reviewId(lang, file.id, key)];
          const approved = review?.status === 'approved' && review.valueHash === hash(text);
          for (const issue of checker.checkString(lang, key, sourceText, text, file.id)) {
            if (approved && !isError(issue)) continue;
            findings.push({
              lang,
              check: issue.check,
              severity: isError(issue) ? 'error' : 'warning',
              file: rel,
              key,
              text,
              note: issue.note,
              group: group.name,
            });
          }
        }
      }
    }
  }
  return findings;
}

/**
 * Repairs placeholder findings that have exactly one possible fix: the source has one
 * placeholder and the translation one brace token with another name ("{heures}" for
 * "{hours}"). The file text is edited in place, so its formatting stays as it is.
 * Returns the repaired findings.
 */
export function fixPlaceholders(config: Config, findings: Finding[]): Finding[] {
  const fixed: Finding[] = [];
  const sources = new Map<string, { values: Map<string, string>; checker: Checker }>();
  for (const group of groupsOf(config)) {
    const checker = new Checker(group);
    for (const file of findSourceFiles(group.root, group.files, group.sourceLanguage)) {
      const doc = readJson(path.join(group.root, file.pathFor(group.sourceLanguage)));
      if (doc) for (const lang of group.targetLanguages) sources.set(file.pathFor(lang), { values: flatten(doc), checker });
    }
  }
  for (const finding of findings.filter(f => f.check === 'placeholder')) {
    const entry = sources.get(finding.file);
    const source = entry?.values.get(finding.key);
    if (!entry || source === undefined) continue;
    const expected: string[] = source.match(entry.checker.placeholderRe) ?? [];
    const tokens: string[] = finding.text.match(/\{\{?[^{}]+\}?\}/g) ?? [];
    const [want, got] = [expected[0], tokens[0]];
    if (new Set(expected).size !== 1 || tokens.length !== 1 || !want || !got || got === want) continue;
    const repaired = finding.text.replace(got, want);
    const file = path.join(config.root, finding.file);
    const text = readText(file);
    const before = JSON.stringify(finding.text).slice(1, -1);
    if (text === null || text.split(before).length !== 2) continue; // not found exactly once
    writeText(file, text.replace(before, JSON.stringify(repaired).slice(1, -1)));
    fixed.push({ ...finding, text: repaired });
  }
  return fixed;
}

/** Table of finding counts per language and check. */
export function summaryTable(findings: Finding[], languages: string[]): string {
  // Built-in checks always; plugin checks when they found something.
  const checks: string[] = [...CHECKS, ...new Set(findings.map(f => f.check).filter(c => !(CHECKS as string[]).includes(c)))];
  const header = ['lang', ...checks];
  const rows = languages.map(lang => [lang, ...checks.map(check => String(findings.filter(f => f.lang === lang && f.check === check).length))]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
