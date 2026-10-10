import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from './config.js';

/**
 * Plugins add project rules without forking localewarden: extra checks, prompt notes,
 * post-processing of model output, and the order in which files are translated.
 * A plugin is an ES module whose default export is a plugin object, or a function that
 * receives the options from the config and returns one.
 *
 *   "plugins": ["./tools/my-rules.mjs", { "module": "./tools/blog.mjs", "options": { "today": "2026-10-09" } }]
 *
 * This interface is experimental in 0.x: it may change in a minor version.
 */
export interface StringContext {
  lang: string;
  key: string;
  /** File id: the path pattern with {lang}, e.g. "locales/{lang}/common.json". */
  file: string;
  source: string;
  text: string;
}

export interface PluginIssue {
  /** Check name, shown in `localewarden check` (e.g. "regional-term"). */
  check: string;
  note?: string;
  /** "error" blocks writing a translation and fails `check`; default "warning". */
  severity?: 'error' | 'warning';
  /** May `--fix-flagged` ask the model to fix it? Default false. */
  fixable?: boolean;
}

export interface FileInfo {
  /** File id with {lang}. */
  id: string;
  /** Path of the source-language file, relative to the project. */
  sourcePath: string;
}

export interface Plugin {
  name: string;
  /** Extra findings for one translated string. */
  checks?(ctx: StringContext): PluginIssue[] | void;
  /** Extra prompt text for a batch of strings (e.g. meanings of terms they contain). */
  promptNotes?(ctx: { lang: string; items: { key: string; source: string }[] }): string | void;
  /** Rewrites a model answer before it is checked and written (e.g. number formats). */
  postProcess?(ctx: StringContext): string | void;
  /** Reorders or filters the source files of a group (e.g. newest blog posts first). */
  order?(files: FileInfo[], ctx: { group?: string }): FileInfo[] | void;
}

export type PluginSpec = string | { module: string; options?: unknown };

/** Loads the plugins listed in the config, relative to the config file. */
export async function loadPlugins(config: Pick<Config, 'plugins' | 'root'>): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const spec of config.plugins ?? []) {
    const modulePath = typeof spec === 'string' ? spec : spec.module;
    const options = typeof spec === 'string' ? undefined : spec.options;
    const file = path.resolve(config.root, modulePath);
    let exported: unknown;
    try {
      exported = (await import(pathToFileURL(file).href)).default;
    } catch (error) {
      throw new Error(`Could not load plugin ${modulePath}: ${(error as Error).message}`);
    }
    const plugin = (typeof exported === 'function' ? await exported(options) : exported) as Plugin;
    if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string') {
      throw new Error(`Plugin ${modulePath} must export a plugin object with a "name" (or a function returning one).`);
    }
    plugins.push(plugin);
  }
  return plugins;
}

/** Calls plugin hooks; an exception names the plugin that threw it. */
export class PluginHost {
  constructor(readonly plugins: Plugin[] = []) {}

  private call<T>(plugin: Plugin, hook: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw new Error(`Plugin "${plugin.name}" failed in ${hook}: ${(error as Error).message}`);
    }
  }

  checks(ctx: StringContext): PluginIssue[] {
    return this.plugins.flatMap(p => (p.checks ? this.call(p, 'checks', () => p.checks!(ctx)) ?? [] : []));
  }

  promptNotes(lang: string, items: { key: string; source: string }[]): string {
    return this.plugins
      .map(p => (p.promptNotes ? this.call(p, 'promptNotes', () => p.promptNotes!({ lang, items })) : undefined))
      .filter((note): note is string => Boolean(note))
      .map(note => ` ${note.trim()}`)
      .join('');
  }

  postProcess(ctx: StringContext): string {
    let text = ctx.text;
    for (const p of this.plugins) {
      if (!p.postProcess) continue;
      const next = this.call(p, 'postProcess', () => p.postProcess!({ ...ctx, text }));
      if (typeof next === 'string') text = next;
    }
    return text;
  }

  order(files: FileInfo[], group?: string): FileInfo[] {
    let result = files;
    for (const p of this.plugins) {
      if (!p.order) continue;
      const next = this.call(p, 'order', () => p.order!(result, { group }));
      if (Array.isArray(next)) result = next;
    }
    return result;
  }
}
