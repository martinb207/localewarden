import path from 'node:path';
import type { Config } from '../config.js';
import { readText, writeText, type LocaleFile } from '../files.js';
import type { RunContext } from './context.js';

/**
 * Writes the locales that are copies of another one (`copies` in the config), e.g. store
 * listings where en-GB is the en-US text. Runs after translating, so copies of target
 * languages get the new translations. A copy is only written when its content differs.
 */
export function applyCopies(ctx: RunContext, config: Config, files: LocaleFile[]): void {
  const only = ctx.options.languages;
  for (const [target, from] of Object.entries(config.copies)) {
    // With --lang, only copies of (or into) the selected languages.
    if (only?.length && !only.includes(target) && !only.includes(from)) continue;
    for (const file of files) {
      const fromRel = file.pathFor(from);
      const toRel = file.pathFor(target);
      const toFile = path.join(config.root, toRel);
      if (!path.resolve(toFile).startsWith(path.resolve(config.root) + path.sep)) continue;
      const text = readText(path.join(config.root, fromRel));
      if (text === null || readText(toFile) === text) continue;
      if (ctx.dryRun) {
        ctx.log.info(`[${target}] ${toRel}: would copy from ${from}`);
        continue;
      }
      writeText(toFile, text);
      ctx.summary.filesCopied.push(toRel);
    }
  }
}
