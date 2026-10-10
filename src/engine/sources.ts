import path from 'node:path';
import type { Config } from '../config.js';
import { findSourceFiles, parseDoc, readText, stringLeaves, type LocaleFile } from '../files.js';
import type { PluginHost } from '../plugins.js';
import type { Scope } from '../scope.js';
import type { Logger } from './context.js';
import type { SourceFile } from './planner.js';

/**
 * The source files of a group, without excluded ones, in the order plugins choose (they may
 * also leave files out, e.g. blog posts scheduled for a later date).
 */
export function listFiles(config: Config, scope: Scope, plugins: PluginHost): LocaleFile[] {
  const files = findSourceFiles(config.root, config.files, config.sourceLanguage).filter(file => !scope.isExcluded(file));
  const byId = new Map(files.map(file => [file.id, file]));
  return plugins
    .order(files.map(file => ({ id: file.id, sourcePath: file.pathFor(config.sourceLanguage) })), config.name)
    .map(info => byId.get(info.id))
    .filter((file): file is LocaleFile => file !== undefined);
}

/** Reads and parses the source files; unreadable ones are reported and skipped. */
export function loadSources(config: Config, files: LocaleFile[], log: Logger): SourceFile[] {
  const sources: SourceFile[] = [];
  for (const file of files) {
    const sourceRel = file.pathFor(config.sourceLanguage);
    const text = readText(path.join(config.root, sourceRel));
    if (text === null) continue;
    try {
      const doc = parseDoc(sourceRel, text);
      const leaves = stringLeaves(doc);
      // {"a.b": …} next to {"a": {"b": …}} flatten to the same key; only one would be kept.
      const seen = new Set<string>();
      for (const leaf of leaves) {
        if (seen.has(leaf.key)) log.warn(`${sourceRel}: key "${leaf.key}" exists twice (as a dotted and a nested key); rename one of them.`);
        seen.add(leaf.key);
      }
      sources.push({ file, doc, text, leaves });
    } catch (error) {
      log.error(`${sourceRel} is not valid JSON (${(error as Error).message}); skipped.`);
    }
  }
  return sources;
}
