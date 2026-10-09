import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, type Config } from '../src/config.js';
import type { Model } from '../src/llm.js';
import type { Logger } from '../src/translate.js';

export function tempProject(files: Record<string, unknown>, config: Record<string, unknown> = {}): Config {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localewarden-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return resolveConfig({ targetLanguages: ['de'], files: 'locales/{lang}.json', ...config }, root);
}

export const readJson = (config: Config, rel: string): any =>
  JSON.parse(fs.readFileSync(path.join(config.root, rel), 'utf8'));

export const writeJson = (config: Config, rel: string, value: unknown): void =>
  fs.writeFileSync(path.join(config.root, rel), JSON.stringify(value, null, 2) + '\n');

/**
 * Fake model: "translates" by prefixing each string with "[lang] ". `transform` can change
 * the output to simulate model mistakes. Records every call.
 */
export function fakeModel(transform: (text: string, system: string) => string = text => text) {
  const calls: { system: string; user: string }[] = [];
  const model: Model = {
    async complete(system, user) {
      calls.push({ system, user });
      const lang = /\(([a-z]{2}(?:-[A-Z]{2})?)\)/.exec(system)?.[1] ?? 'xx';
      const translate = (text: string) => transform(`[${lang}] ${text}`, system);
      if (system.includes('JSON array')) {
        const items = JSON.parse(user) as string[];
        return { text: JSON.stringify(items.map(translate)), tokens: 100 };
      }
      return { text: translate(user), tokens: 50 };
    },
  };
  return { model, calls };
}

export const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
