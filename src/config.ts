import fs from 'node:fs';
import path from 'node:path';
import type { PluginSpec } from './plugins.js';

export type Register = 'formal' | 'informal';

export interface Config {
  /** Language of the source files. Default "en". Several checks assume English. */
  sourceLanguage: string;
  /** Languages to translate into, e.g. ["de", "fr", "pt-BR"]. */
  targetLanguages: string[];
  /** Locale file pattern relative to the config file, with {lang}; * and **\/ allowed. */
  files: string;
  /** One or two sentences about the product, so the model picks the right meaning. */
  context?: string;
  /** Desired voice, e.g. "friendly and plain, no marketing hype". */
  tone?: string;
  /** Names that must stay exactly as written (brand, product and feature names). */
  doNotTranslate: string[];
  /** Form of address per language: { "de": "informal", "fr": "formal" }. */
  formality: Record<string, Register>;
  /** Avoid gendered forms when addressing the user (they/them equivalent per language). */
  genderNeutral: boolean;
  /** Use sentence case in languages that do not capitalise titles like English. */
  sentenceCase: boolean;
  /** Required renderings per language: { "fr": { "Terms of Service": "Conditions d'utilisation" } }. */
  glossary: Record<string, Record<string, string>>;
  /** Meanings of ambiguous terms, added to the prompt only when a string contains them. */
  termNotes: Record<string, string>;
  /** Extra instructions per language; "*" applies to every language. */
  instructions: Record<string, string>;
  /**
   * Keys whose values are not text (ids, types, image paths). Copied from the source, never
   * translated. "*" matches within one key segment, "**" across segments; a pattern without
   * a dot matches the last segment anywhere ("id" matches "steps.2.id").
   */
  ignoreKeys: string[];
  /** Source files to skip, as path patterns relative to the config ("locales/{lang}/nav.json"). */
  exclude: string[];
  /** Maximum characters per key pattern: { "**.meta.title": 60 }. Told to the model and checked. */
  maxLength: Record<string, number>;
  /** Regular expressions (as strings) that match placeholders. Replaces the built-in list. */
  placeholders?: string[];
  model: string;
  /** Any OpenAI-compatible chat completions endpoint. */
  baseUrl: string;
  /** Name of the environment variable that holds the API key. */
  apiKeyEnv: string;
  temperature?: number;
  /** For reasoning models (gpt-5*, o*): "none" | "minimal" | "low" | "medium" | "high". */
  reasoningEffort?: string;
  /** Hard stop for one run, counted from the token usage the API reports. */
  maxTokensPerRun: number;
  /** Languages translated in parallel. */
  concurrency: number;
  /** Strings per request. */
  batchSize: number;
  /** Where state, review list and repair report live, relative to the config file. */
  stateDir: string;
  /**
   * Target locales that are a copy of another one instead of a translation, e.g. store
   * listings: { "en-GB": "en-US", "fr-CA": "fr-FR" }. The value may be the source language.
   */
  copies: Record<string, string>;
  /** Strings longer than this many characters are translated paragraph by paragraph. */
  chunkChars: number;
  /** Plugin modules (relative to the config file), see plugins.ts. */
  plugins: PluginSpec[];
  /** Token limit per UTC day across runs; usage is kept in <stateDir>/usage.json. */
  dailyTokenBudget?: number;
  /** Group name, when this config is one of `groups`. */
  name?: string;
  /**
   * Parts of the project with their own files and settings, translated in this order
   * (e.g. app UI first, long-form content last). Each group inherits the top-level settings.
   */
  groups?: Config[];
  /** Directory of the config file; all relative paths resolve against it. */
  root: string;
}

export const CONFIG_FILE = 'localewarden.config.json';

export const DEFAULTS: Omit<Config, 'targetLanguages' | 'files' | 'root' | 'groups' | 'name'> = {
  sourceLanguage: 'en',
  doNotTranslate: [],
  formality: {},
  genderNeutral: true,
  sentenceCase: true,
  glossary: {},
  termNotes: {},
  instructions: {},
  ignoreKeys: [],
  exclude: [],
  maxLength: {},
  model: 'gpt-5.4-mini',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
  maxTokensPerRun: 500_000,
  concurrency: 4,
  batchSize: 20,
  stateDir: '.localewarden',
  copies: {},
  chunkChars: 8000,
  plugins: [],
};

/** Settings that apply to the whole run and cannot differ per group. */
const GLOBAL_ONLY = ['groups', 'stateDir', 'plugins', 'dailyTokenBudget', 'maxTokensPerRun', 'concurrency'];

export class ConfigError extends Error {}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value as object).every(v => typeof v === 'string');

/** Validates a parsed config object and fills in defaults. */
export function resolveConfig(raw: unknown, root: string): Config {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('The config must be a JSON object.');
  }
  const { groups, ...rest } = raw as Record<string, unknown>;
  if (groups === undefined) return resolveSingle(rest, root);
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new ConfigError('"groups" must be a non-empty list of { "name", "files", ... } objects.');
  }
  const names = new Set<string>();
  const resolved = groups.map((group, i) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new ConfigError(`groups[${i}] must be an object.`);
    const g = group as Record<string, unknown>;
    if (typeof g.name !== 'string' || g.name === '') throw new ConfigError(`groups[${i}] needs a "name".`);
    if (names.has(g.name)) throw new ConfigError(`Group name "${g.name}" is used twice.`);
    names.add(g.name);
    const global = Object.keys(g).filter(key => GLOBAL_ONLY.includes(key));
    if (global.length > 0) throw new ConfigError(`groups[${i}] ("${g.name}"): ${global.join(', ')} can only be set at the top level.`);
    try {
      return resolveSingle(mergeGroup(rest, g), root);
    } catch (error) {
      throw new ConfigError(`Group "${g.name}": ${(error as Error).message}`);
    }
  });
  return { ...resolved[0], name: undefined, groups: resolved };
}

/** Settings a group merges with the top level instead of replacing. */
const MERGED_OBJECTS = ['formality', 'termNotes', 'instructions', 'maxLength'];
const MERGED_LISTS = ['doNotTranslate', 'ignoreKeys', 'exclude'];

/**
 * A group's settings on top of the top-level ones: maps (formality, glossary per language,
 * termNotes, instructions, maxLength) are merged, lists (doNotTranslate, ignoreKeys, exclude)
 * extended, everything else replaced. `copies` belong to the locales they name: a group with
 * its own languages does not inherit them.
 */
function mergeGroup(base: Record<string, unknown>, group: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...group };
  const asObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  for (const key of MERGED_OBJECTS) {
    if (key in group && key in base) merged[key] = { ...asObject(base[key]), ...asObject(group[key]) };
  }
  if ('glossary' in group && 'glossary' in base) {
    const glossary: Record<string, unknown> = { ...asObject(base.glossary) };
    for (const [lang, terms] of Object.entries(asObject(group.glossary))) glossary[lang] = { ...asObject(glossary[lang]), ...asObject(terms) };
    merged.glossary = glossary;
  }
  for (const key of MERGED_LISTS) {
    if (Array.isArray(group[key]) && Array.isArray(base[key])) merged[key] = [...new Set([...(base[key] as unknown[]), ...(group[key] as unknown[])])];
  }
  if (!('copies' in group) && ('targetLanguages' in group || 'sourceLanguage' in group)) merged.copies = {};
  return merged;
}

/** The groups of a config, or the config itself as its only group. */
export const groupsOf = (config: Config): Config[] => config.groups ?? [config];

/**
 * The groups to work on, in config order, limited by name; unknown group or language names
 * are an error (a typo must not turn into "nothing to do" or a green check).
 */
export function selectGroups(config: Config, names?: string[], languages?: string[]): Config[] {
  const groups = groupsOf(config);
  let selected = groups;
  if (names?.length) {
    const unknown = names.filter(name => !groups.some(g => g.name === name));
    if (unknown.length > 0) {
      throw new ConfigError(`Unknown group(s): ${unknown.join(', ')}. Groups: ${groups.map(g => g.name ?? '(none)').join(', ')}`);
    }
    selected = groups.filter(g => g.name !== undefined && names.includes(g.name));
  }
  const targets = new Set(selected.flatMap(g => g.targetLanguages));
  const unknownLanguages = (languages ?? []).filter(lang => !targets.has(lang));
  if (unknownLanguages.length > 0) {
    throw new ConfigError(`Not in targetLanguages: ${unknownLanguages.join(', ')}`);
  }
  return selected;
}

function resolveSingle(input: Record<string, unknown>, root: string): Config {
  const config = { ...DEFAULTS, ...input, root } as Config;
  const fail = (message: string): never => {
    throw new ConfigError(message);
  };

  if (typeof config.files !== 'string' || !config.files.includes('{lang}')) {
    fail('"files" must be a path pattern containing {lang}, e.g. "locales/{lang}.json".');
  }
  // Files are written next to the config only: no absolute paths, no "..".
  if (path.isAbsolute(config.files) || /^[a-z]:/i.test(config.files) || config.files.split(/[\\/]/).includes('..')) {
    fail('"files" must be a relative path inside the project (no absolute paths, no "..").');
  }
  const isLanguageCode = (l: unknown) => typeof l === 'string' && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(l);
  if (!isLanguageCode(config.sourceLanguage)) fail('"sourceLanguage" must be a language code, e.g. "en".');
  if (
    !Array.isArray(config.targetLanguages) ||
    config.targetLanguages.length === 0 ||
    !config.targetLanguages.every(isLanguageCode)
  ) {
    fail('"targetLanguages" must be a non-empty list of language codes, e.g. ["de", "fr"].');
  }
  if (config.targetLanguages.includes(config.sourceLanguage)) {
    fail(`"targetLanguages" must not contain the source language "${config.sourceLanguage}".`);
  }
  if (!Array.isArray(config.doNotTranslate) || !config.doNotTranslate.every(t => typeof t === 'string')) {
    fail('"doNotTranslate" must be a list of strings.');
  }
  for (const [lang, register] of Object.entries(config.formality ?? {})) {
    if (register !== 'formal' && register !== 'informal') {
      fail(`"formality.${lang}" must be "formal" or "informal".`);
    }
  }
  if (
    !config.glossary ||
    typeof config.glossary !== 'object' ||
    !Object.values(config.glossary).every(isStringRecord)
  ) {
    fail('"glossary" must map languages to { "source term": "required rendering" } objects.');
  }
  for (const key of ['ignoreKeys', 'exclude'] as const) {
    if (!Array.isArray(config[key]) || !config[key].every(p => typeof p === 'string' && p !== '')) {
      fail(`"${key}" must be a list of patterns.`);
    }
  }
  if (
    !config.maxLength ||
    typeof config.maxLength !== 'object' ||
    !Object.values(config.maxLength).every(n => Number.isInteger(n) && n > 0)
  ) {
    fail('"maxLength" must map key patterns to positive whole numbers, e.g. { "**.meta.title": 60 }.');
  }
  if (!isStringRecord(config.termNotes)) fail('"termNotes" must map terms to explanations.');
  if (!isStringRecord(config.instructions)) fail('"instructions" must map languages to text.');
  if (config.placeholders !== undefined) {
    if (!Array.isArray(config.placeholders)) fail('"placeholders" must be a list of regular expressions.');
    for (const source of config.placeholders ?? []) {
      try {
        new RegExp(source, 'g');
      } catch (error) {
        fail(`Invalid placeholder pattern ${JSON.stringify(source)}: ${(error as Error).message}`);
      }
    }
  }
  if (!isStringRecord(config.copies)) fail('"copies" must map locales to the locale they copy, e.g. { "en-GB": "en-US" }.');
  for (const [target, from] of Object.entries(config.copies)) {
    if (!isLanguageCode(target)) fail(`"copies": "${target}" is not a language code.`);
    if (config.targetLanguages.includes(target)) fail(`"copies": "${target}" is also in targetLanguages.`);
    if (from !== config.sourceLanguage && !config.targetLanguages.includes(from)) {
      fail(`"copies.${target}": "${from}" must be the source language or one of targetLanguages.`);
    }
  }
  if (!Array.isArray(config.plugins)) fail('"plugins" must be a list of module paths.');
  if (config.dailyTokenBudget !== undefined && !(Number.isFinite(config.dailyTokenBudget) && config.dailyTokenBudget > 0)) {
    fail('"dailyTokenBudget" must be a positive number.');
  }
  for (const key of ['maxTokensPerRun', 'concurrency', 'batchSize', 'chunkChars'] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 1) fail(`"${key}" must be a positive number.`);
  }
  for (const key of ['model', 'baseUrl', 'apiKeyEnv', 'stateDir', 'sourceLanguage'] as const) {
    if (typeof config[key] !== 'string' || config[key] === '') fail(`"${key}" must be a string.`);
  }
  const known = new Set([...Object.keys(DEFAULTS), 'targetLanguages', 'files', 'context', 'tone', 'temperature', 'reasoningEffort', 'placeholders', 'dailyTokenBudget', 'name', '$schema']);
  const unknown = Object.keys(input).filter(key => !known.has(key));
  if (unknown.length > 0) fail(`Unknown config option(s): ${unknown.join(', ')}`);
  config.baseUrl = config.baseUrl.replace(/\/+$/, '');
  return config;
}

/** Loads the config file (default: localewarden.config.json in the working directory). */
export function loadConfig(configPath?: string): Config {
  const file = path.resolve(configPath ?? CONFIG_FILE);
  if (!fs.existsSync(file)) {
    throw new ConfigError(
      `No config found at ${file}. Run "npx localewarden init" to create one.`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Could not parse ${file}: ${(error as Error).message}`);
  }
  return resolveConfig(raw, path.dirname(file));
}
