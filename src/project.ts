import path from 'node:path';
import { CHECKS, Checker, ERROR_CHECKS, type CheckName } from './checks.js';
import type { Config } from './config.js';
import { findSourceFiles, flatten, readText, type JsonValue } from './files.js';
import { reviewId, State } from './state.js';
import { hash } from './util.js';

export interface Finding {
  lang: string;
  check: CheckName;
  severity: 'error' | 'warning';
  file: string;
  key: string;
  text: string;
  note?: string;
}

function readJson(file: string): JsonValue | null {
  const text = readText(file);
  return text === null ? null : (JSON.parse(text) as JsonValue);
}

/**
 * Runs the quality checks over every translated string. Approved hand edits are skipped
 * except for placeholder and script errors, which break the app either way.
 */
export function checkProject(config: Config, languages: string[] = config.targetLanguages): Finding[] {
  const checker = new Checker(config);
  const state = new State(path.join(config.root, config.stateDir));
  const findings: Finding[] = [];
  for (const file of findSourceFiles(config.root, config.files, config.sourceLanguage)) {
    const sourceDoc = readJson(path.join(config.root, file.pathFor(config.sourceLanguage)));
    if (sourceDoc === null) continue;
    const source = flatten(sourceDoc);
    for (const lang of languages) {
      const rel = file.pathFor(lang);
      let doc: JsonValue | null;
      try {
        doc = readJson(path.join(config.root, rel));
      } catch (error) {
        findings.push({ lang, check: 'markup', severity: 'error', file: rel, key: '(file)', text: '', note: `invalid JSON: ${(error as Error).message}` });
        continue;
      }
      if (doc === null) continue;
      for (const [key, text] of flatten(doc)) {
        // Plural forms only the target language has are checked against the source "_other".
        const sourceText = source.get(key) ?? (/_(zero|one|two|few|many)$/.test(key) ? source.get(key.replace(/_(zero|one|two|few|many)$/, '_other')) : undefined);
        if (sourceText === undefined || sourceText.trim() === '') continue;
        const review = state.review[reviewId(lang, file.id, key)];
        const approved = review?.status === 'approved' && review.valueHash === hash(text);
        for (const issue of checker.checkString(lang, key, sourceText, text)) {
          if (approved && !ERROR_CHECKS.has(issue.check)) continue;
          findings.push({
            lang,
            check: issue.check,
            severity: ERROR_CHECKS.has(issue.check) ? 'error' : 'warning',
            file: rel,
            key,
            text,
            note: issue.note,
          });
        }
      }
    }
  }
  return findings;
}

/** Table of finding counts per language and check. */
export function summaryTable(findings: Finding[], languages: string[]): string {
  const header = ['lang', ...CHECKS];
  const rows = languages.map(lang => [lang, ...CHECKS.map(check => String(findings.filter(f => f.lang === lang && f.check === check).length))]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
