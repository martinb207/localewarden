import fs from 'node:fs';
import path from 'node:path';

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
  /** Directory of the config file; all relative paths resolve against it. */
  root: string;
}

export const CONFIG_FILE = 'localewarden.config.json';

export const DEFAULTS: Omit<Config, 'targetLanguages' | 'files' | 'root'> = {
  sourceLanguage: 'en',
  doNotTranslate: [],
  formality: {},
  genderNeutral: true,
  sentenceCase: true,
  glossary: {},
  termNotes: {},
  instructions: {},
  model: 'gpt-5.4-mini',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
  maxTokensPerRun: 500_000,
  concurrency: 4,
  batchSize: 20,
  stateDir: '.localewarden',
};

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
  const input = raw as Record<string, unknown>;
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
  for (const key of ['maxTokensPerRun', 'concurrency', 'batchSize'] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 1) fail(`"${key}" must be a positive number.`);
  }
  for (const key of ['model', 'baseUrl', 'apiKeyEnv', 'stateDir', 'sourceLanguage'] as const) {
    if (typeof config[key] !== 'string' || config[key] === '') fail(`"${key}" must be a string.`);
  }
  const known = new Set([...Object.keys(DEFAULTS), 'targetLanguages', 'files', 'context', 'tone', 'temperature', 'reasoningEffort', 'placeholders', '$schema']);
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
