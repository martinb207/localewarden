import type { Config } from './config.js';
import { placeholderRegExp, placeholderSignature, placeholdersMatch } from './placeholders.js';
import {
  GENDERED_FORMS,
  NO_AMPERSAND_LANGUAGES,
  SENTENCE_CASE_LANGUAGES,
  formalityRule,
  registerFor,
  withoutQuotedSpeech,
} from './style.js';
import { baseLanguage, escapeRegExp } from './util.js';

/**
 * Deterministic quality checks. No API calls, so they can run in CI on every commit.
 *
 *   placeholder   placeholder set differs from the source                        error
 *   unsafe        HTML tags, attributes, event handlers or javascript:/data: URLs
 *                 that the source does not have (script injection)               error
 *   script        letters from a script the language does not use, or a word
 *                 mixing Latin with Cyrillic/Greek lookalikes                    error
 *   markup        links, tags or list items differ from the source; broken tags
 *   years         a year from the source is missing or changed (citations, dates)
 *   formality     the other form of address than configured, or both mixed;
 *                 masculine-only forms for "you" when genderNeutral is on
 *   titlecase     English Title Case copied into a sentence-case language
 *   ampersand     "&" in a language that writes the word
 *   glossary      a glossary rendering or a doNotTranslate name is missing
 *   untranslated  identical to the source (prose of 3+ words)
 *   partial       source-language words left inside an otherwise translated string,
 *                 or a dropped hedge ("tend to" stated as certain)
 */
export type CheckName =
  | 'placeholder'
  | 'unsafe'
  | 'script'
  | 'markup'
  | 'years'
  | 'formality'
  | 'titlecase'
  | 'ampersand'
  | 'glossary'
  | 'untranslated'
  | 'partial';

export const CHECKS: CheckName[] = [
  'placeholder',
  'unsafe',
  'script',
  'markup',
  'years',
  'formality',
  'titlecase',
  'ampersand',
  'glossary',
  'untranslated',
  'partial',
];

export const ERROR_CHECKS = new Set<CheckName>(['placeholder', 'unsafe', 'script']);

/** Checks a targeted repair (--fix-flagged) may try to fix. */
export const FIXABLE_CHECKS = new Set<CheckName>([
  'script',
  'markup',
  'years',
  'formality',
  'titlecase',
  'ampersand',
  'glossary',
  'partial',
]);

export interface Issue {
  check: CheckName;
  note?: string;
}

export class Checker {
  readonly config: Config;
  readonly placeholderRe: RegExp;

  constructor(config: Config) {
    this.config = config;
    this.placeholderRe = placeholderRegExp(config.placeholders);
  }

  get englishSource(): boolean {
    return baseLanguage(this.config.sourceLanguage) === 'en';
  }

  placeholdersMatch(key: string, source: string, text: string): boolean {
    return placeholdersMatch(key, source, text, this.placeholderRe);
  }

  placeholderNote(source: string, text: string): string {
    return `source has [${placeholderSignature(source, this.placeholderRe)}], got [${placeholderSignature(text, this.placeholderRe)}]`;
  }

  /** All issues of one translated string. */
  checkString(lang: string, key: string, source: string, text: string): Issue[] {
    const issues: Issue[] = [];
    const add = (check: CheckName, note?: string) => issues.push({ check, note });
    const base = baseLanguage(lang);

    if (!this.placeholdersMatch(key, source, text)) add('placeholder', this.placeholderNote(source, text));
    const unsafe = unsafeAdditions(source, text);
    if (unsafe) add('unsafe', unsafe);
    const foreign = foreignScript(this.config.sourceLanguage, source) ? null : foreignScript(lang, text);
    if (foreign) add('script', foreign);

    for (const note of markupDifferences(source, text)) add('markup', note);
    const years = yearDifference(source, text);
    if (years) add('years', years);

    const missingTerms = missingGlossaryTerms(this.config, lang, source, text);
    if (missingTerms.length > 0) add('glossary', `expected ${missingTerms.join('; ')}`);
    const missingNames = this.config.doNotTranslate.filter(name => keptNameMissing(name, source, text));
    if (missingNames.length > 0) add('glossary', `name not kept: ${missingNames.join(', ')}`);

    const register = registerFor(this.config, lang);
    const rule = formalityRule(lang);
    if (register && rule) {
      const unquoted = withoutQuotedSpeech(text);
      const informal = rule.informal.pattern.test(unquoted);
      const formal = rule.formal.pattern.test(unquoted);
      if (informal && formal) add('formality', 'mixes both forms of address');
      else if (register === 'formal' && informal) add('formality', 'informal address, config says formal');
      else if (register === 'informal' && formal) add('formality', 'formal address, config says informal');
    }
    if (this.config.genderNeutral) {
      const gendered = GENDERED_FORMS[base]?.exec(withoutQuotedSpeech(text));
      if (gendered) add('formality', `addresses the user in one gender only: «${gendered[0].trim()}»`);
    }

    if (
      this.englishSource &&
      this.config.sentenceCase &&
      SENTENCE_CASE_LANGUAGES.has(base) &&
      isEnglishTitleCase(source)
    ) {
      const capitals = midCapitals(text, source, this.config.doNotTranslate);
      if (capitals.length >= (source.trim().split(/\s+/).length <= 3 ? 1 : 2)) {
        add('titlecase', `capitalised: ${capitals.join(' ')}`);
      }
    }

    const ampersands = (value: string) => value.split(' & ').length - 1;
    if (NO_AMPERSAND_LANGUAGES.has(base) && ampersands(text) > ampersands(source)) add('ampersand');

    if (isUnchangedProse(source, text, this.placeholderRe)) add('untranslated');

    if (this.englishSource && text !== source) {
      const copied = sourceRun(source, text);
      if (copied) add('partial', `source text left in: "${copied}"`);
      const lead = !copied ? sourceBoldLeadIn(source, text, this.config.doNotTranslate) : null;
      if (lead) add('partial', `bold lead-in still in the source language: "${lead}"`);
      const mixed = !copied && !lead ? englishInNativeScript(lang, source, text, this.placeholderRe) : null;
      if (mixed) add('partial', mixed);
      if (droppedHedge(lang, source, text)) {
        add('partial', 'hedge dropped: the source says "tend to", the translation states it as certain');
      }
    }
    return issues;
  }

  /**
   * Output check right after the API call.
   *   hard: certain corruption (placeholders, foreign alphabet, changed link targets, broken
   *         markup, source echoed back). Retried once; if still present, never written.
   *   soft: likely loss (tag count, missing year, source words left in). Retried once, then
   *         accepted; `localewarden check` keeps reporting it.
   */
  defect(lang: string, key: string, source: string, text: string): { hard: string | null; soft: string | null } {
    if (!text.trim()) return { hard: 'empty translation', soft: null };
    const placeholders = this.placeholdersMatch(key, source, text) ? null : `placeholder mismatch: ${this.placeholderNote(source, text)}`;
    const foreign = foreignScript(this.config.sourceLanguage, source) ? null : foreignScript(lang, text);
    const links = hrefSignature(source) !== hrefSignature(text) ? `links changed: [${hrefSignature(source)}] -> [${hrefSignature(text)}]` : null;
    const echoed = isUnchangedProse(source, text, this.placeholderRe) ? 'returned the source text unchanged' : null;
    const broken = brokenMarkup(source) ? null : brokenMarkup(text);
    const boldMarkers = (value: string) => (value.match(/\*\*/g) ?? []).length % 2;
    const brokenBold = boldMarkers(text) === 1 && boldMarkers(source) === 0 ? 'unbalanced ** markers' : null;
    const leaked = /^(here('s| is) the translation|translation:)/i.test(text.trim()) ? 'model commentary in the output' : null;
    const hard = placeholders ?? unsafeAdditions(source, text) ?? foreign ?? links ?? echoed ?? broken ?? brokenBold ?? droppedBullets(source, text) ?? leaked;
    const tags = tagCount(source) !== tagCount(text) ? `${tagCount(source)} tags in the source, got ${tagCount(text)}` : null;
    const copied = this.englishSource && text !== source ? sourceRun(source, text) : null;
    return { hard, soft: hard ?? tags ?? yearDifference(source, text) ?? (copied ? `source text left in: "${copied}"` : null) };
  }
}

// ---------------------------------------------------------------------------------------
// Scripts

const SCRIPTS: Record<string, RegExp> = {
  Cyrillic: /\p{Script=Cyrillic}/u,
  Greek: /\p{Script=Greek}/u,
  Arabic: /\p{Script=Arabic}/u,
  Hebrew: /\p{Script=Hebrew}/u,
  Devanagari: /\p{Script=Devanagari}/u,
  Bengali: /\p{Script=Bengali}/u,
  Thai: /\p{Script=Thai}/u,
  Han: /\p{Script=Han}/u,
  Kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
  Hangul: /\p{Script=Hangul}/u,
  Georgian: /\p{Script=Georgian}/u,
  Armenian: /\p{Script=Armenian}/u,
  Tamil: /\p{Script=Tamil}/u,
  Telugu: /\p{Script=Telugu}/u,
  Kannada: /\p{Script=Kannada}/u,
  Malayalam: /\p{Script=Malayalam}/u,
  Gujarati: /\p{Script=Gujarati}/u,
  Gurmukhi: /\p{Script=Gurmukhi}/u,
  Sinhala: /\p{Script=Sinhala}/u,
  Myanmar: /\p{Script=Myanmar}/u,
  Khmer: /\p{Script=Khmer}/u,
  Lao: /\p{Script=Lao}/u,
  Ethiopic: /\p{Script=Ethiopic}/u,
};

/** Non-Latin scripts each language is written in. Latin is always allowed (names, codes). */
export const NATIVE_SCRIPTS: Record<string, string[]> = {
  ru: ['Cyrillic'], uk: ['Cyrillic'], bg: ['Cyrillic'], be: ['Cyrillic'], mk: ['Cyrillic'],
  sr: ['Cyrillic'], kk: ['Cyrillic'], ky: ['Cyrillic'], mn: ['Cyrillic'], tg: ['Cyrillic'],
  el: ['Greek'],
  ar: ['Arabic'], fa: ['Arabic'], ur: ['Arabic'], ps: ['Arabic'], ckb: ['Arabic'],
  he: ['Hebrew'], yi: ['Hebrew'],
  hi: ['Devanagari'], mr: ['Devanagari'], ne: ['Devanagari'], sa: ['Devanagari'],
  bn: ['Bengali'], as: ['Bengali'],
  th: ['Thai'], zh: ['Han'], ja: ['Han', 'Kana'], ko: ['Hangul', 'Han'],
  ka: ['Georgian'], hy: ['Armenian'], ta: ['Tamil'], te: ['Telugu'], kn: ['Kannada'],
  ml: ['Malayalam'], gu: ['Gujarati'], pa: ['Gurmukhi'], si: ['Sinhala'], my: ['Myanmar'],
  km: ['Khmer'], lo: ['Lao'], am: ['Ethiopic'],
};

/** Languages written in Latin script only. Unknown languages are not script-checked. */
const LATIN_LANGUAGES = new Set([
  'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'no', 'nb', 'nn', 'da', 'fi', 'is', 'pl',
  'cs', 'sk', 'sl', 'hr', 'bs', 'hu', 'ro', 'ca', 'gl', 'eu', 'id', 'ms', 'tl', 'fil', 'sw',
  'zu', 'xh', 'af', 'tr', 'az', 'uz', 'vi', 'et', 'lv', 'lt', 'ga', 'cy', 'mt', 'sq', 'lb',
  'eo', 'ha', 'yo', 'ig', 'so', 'mg',
]);

// Latin glued to a lookalike alphabet inside one word ("Вarda": Cyrillic В + Latin arda).
const HOMOGLYPH_WORD = /(?=\p{L}*\p{Script=Latin})(?=\p{L}*[\p{Script=Cyrillic}\p{Script=Greek}])\p{L}+/u;

/** Why `text` contains letters that cannot belong to `lang`, or null. */
export function foreignScript(lang: string, text: string): string | null {
  const base = baseLanguage(lang);
  const native = NATIVE_SCRIPTS[base] ?? (LATIN_LANGUAGES.has(base) ? [] : null);
  if (native === null) return null;
  const letters = text.replace(/[।॥]/g, ''); // danda: punctuation shared by Indic scripts
  for (const [script, re] of Object.entries(SCRIPTS)) {
    if (native.includes(script)) continue;
    // A lone Greek letter is a symbol (α, β, θ), not corruption.
    const hits = letters
      .match(new RegExp(`${re.source}+`, 'gu'))
      ?.filter(run => script !== 'Greek' || [...run].length > 1);
    if (hits?.length) return `${script} in ${lang}: ${hits.slice(0, 3).join(' ')}`;
  }
  if (base === 'sr') return null; // Serbian is written in both Cyrillic and Latin
  const mixed = text.match(HOMOGLYPH_WORD);
  return mixed ? `mixed-alphabet word: ${mixed[0]}` : null;
}

// ---------------------------------------------------------------------------------------
// Unsafe additions

const unescapeEntities = (text: string): string =>
  text
    .replace(/&lt;|&#0*60;|&#x0*3c;/gi, '<')
    .replace(/&gt;|&#0*62;|&#x0*3e;/gi, '>')
    .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&colon;|&#0*58;|&#x0*3a;/gi, ':');

/** Tag names, in lower case. Numbered <0> tags (react-i18next) are placeholders, not HTML. */
const tagNames = (html: string): Set<string> =>
  new Set([...html.matchAll(/<\/?([a-z][\w-]*)/gi)].map(m => m[1].toLowerCase()));

const TEXT_ATTRIBUTES = new Set(['title', 'alt', 'aria-label', 'aria-description', 'placeholder']);

/** Every attribute as "name=value" (value without quotes), in lower case. */
const attributes = (html: string): Set<string> => {
  const found = new Set<string>();
  for (const [, inner] of html.matchAll(/<[a-z][\w-]*\s([^>]*)>?/gi)) {
    for (const [, name, v1, v2, v3] of inner.matchAll(/([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const attr = name.toLowerCase();
      // Text attributes are translated along with the visible text; only their presence counts.
      const value = TEXT_ATTRIBUTES.has(attr) ? '*' : (v1 ?? v2 ?? v3 ?? '').trim().toLowerCase();
      found.add(`${attr}=${value}`);
    }
  }
  return found;
};

const DANGEROUS_URL = /(?:javascript|vbscript|data)\s*:/gi;

/**
 * Markup the translation adds that the source does not have: a new tag type, a new or changed
 * attribute, an event handler or a script URL. Translations are often rendered as raw HTML
 * (dangerouslySetInnerHTML, v-html), so such an addition is a script-injection risk, whether
 * it comes from a model mistake or from a manipulated source string or response.
 */
export function unsafeAdditions(source: string, text: string): string | null {
  const [src, out] = [unescapeEntities(source), unescapeEntities(text)];
  const srcTags = tagNames(src);
  const newTags = [...tagNames(out)].filter(tag => !srcTags.has(tag) && tag !== 'br');
  if (newTags.length > 0) return `HTML tag not in the source: <${newTags.join('>, <')}>`;
  const srcAttrs = attributes(src);
  const newAttrs = [...attributes(out)].filter(attr => !srcAttrs.has(attr));
  const handler = newAttrs.find(attr => /^on/.test(attr));
  if (handler) return `event handler not in the source: ${handler.split('=')[0]}`;
  if (newAttrs.length > 0) return `HTML attribute not in the source: ${newAttrs[0]}`;
  const urls = (value: string) => (value.match(DANGEROUS_URL) ?? []).length;
  if (urls(out) > urls(src)) return 'javascript:, vbscript: or data: URL not in the source';
  return null;
}

// ---------------------------------------------------------------------------------------
// Markup

const unescapeHtml = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

export const hrefSignature = (text: string): string =>
  (unescapeHtml(text).match(/href\s*=\s*"[^"]*"/g) ?? []).sort().join(' ');

const tagCount = (text: string): number =>
  (unescapeHtml(text).match(/<\/?(?:a|strong|em|b|i|li|ul|ol|p|br|span|code)\b/gi) ?? []).length;

/** A malformed, unclosed or misnested tag, or null. */
export function brokenMarkup(text: string): string | null {
  const html = unescapeHtml(text);
  const malformed = html.match(/<(?:strong|em|li|ul|ol|b|i)\s[^>]*/i);
  if (malformed && !/^<\w+\s+[\w-]+\s*=/.test(malformed[0])) return `malformed tag "${malformed[0].slice(0, 40)}"`;
  const open: string[] = [];
  for (const [, close, name] of html.matchAll(/<(\/?)(strong|em|a|li|ul|ol|b|i|p|span|code)\b[^>]*>/gi)) {
    const tag = name.toLowerCase();
    if (!close) open.push(tag);
    else if (open.pop() !== tag) return `misnested </${tag}>`;
  }
  return open.length > 0 ? `unclosed <${open.join('>, <')}>` : null;
}

/** Fewer "•" list items than the source: items dropped at the end of a long text. */
export function droppedBullets(source: string, text: string): string | null {
  const bullets = (value: string) => (value.match(/[•・]/g) ?? []).length;
  return bullets(text) < bullets(source) ? `list items dropped: ${bullets(source)} in the source, got ${bullets(text)}` : null;
}

function markupDifferences(source: string, text: string): string[] {
  const notes: string[] = [];
  if (hrefSignature(source) !== hrefSignature(text)) {
    notes.push(`links differ: [${hrefSignature(source)}] vs [${hrefSignature(text)}]`);
  }
  if (tagCount(source) !== tagCount(text)) notes.push(`${tagCount(source)} tags in the source, got ${tagCount(text)}`);
  const broken = brokenMarkup(source) ? null : brokenMarkup(text);
  if (broken) notes.push(broken);
  const dropped = droppedBullets(source, text);
  if (dropped) notes.push(dropped);
  return notes;
}

// ---------------------------------------------------------------------------------------
// Years

// Native digits -> ASCII, so "২০১৫" matches "2015".
const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xe50];
const asciiDigits = (text: string): string =>
  text.replace(/\p{Nd}/gu, ch => {
    const code = ch.codePointAt(0) ?? 0;
    const zero = DIGIT_ZEROS.find(z => code >= z && code < z + 10);
    return zero === undefined ? ch : String(code - zero);
  });

export function yearDifference(source: string, text: string): string | null {
  // Decades ("the 2020s") are written in words or with suffixes in many languages.
  const decades = new Set(asciiDigits(source).match(/(?<!\d)(?:19|20)\d0(?=['’]?s\b)/g) ?? []);
  const years = (value: string) =>
    (asciiDigits(value).match(/(?<!\d)(?:19|20)\d\d(?!\d)/g) ?? []).filter(y => !decades.has(y)).sort().join(',');
  const [a, b] = [years(source), years(text)];
  return a === b ? null : `source years [${a}], got [${b}]`;
}

// ---------------------------------------------------------------------------------------
// Glossary and names

/**
 * Whether `translation` contains `target`, allowing case endings: every target word of 3+
 * letters must appear in order as the start of a translation word, minus up to two final
 * letters ("Polityka prywatności" matches "Polityką prywatności").
 */
export function containsInflected(lang: string, translation: string, target: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase(lang).replace(/[’`]/g, "'");
  if (normalize(translation).includes(normalize(target))) return true;
  const words = normalize(translation).split(/[^\p{L}\p{M}']+/u).filter(Boolean);
  let from = 0;
  for (const word of normalize(target).split(/[^\p{L}\p{M}']+/u)) {
    if ([...word].length < 3) continue;
    // Finnish consonant gradation changes the stem end when inflected.
    const cut = baseLanguage(lang) === 'fi' ? 3 : 2;
    const stem = [...word].slice(0, Math.max(3, [...word].length - cut)).join('');
    const found = words.findIndex((candidate, i) => i >= from && candidate.startsWith(stem));
    if (found === -1) return false;
    from = found + 1;
  }
  return true;
}

/** Glossary terms in `source` whose required rendering is missing from `translation`. */
export function missingGlossaryTerms(config: Config, lang: string, source: string, translation: string): string[] {
  const glossary = { ...config.glossary[baseLanguage(lang)], ...config.glossary[lang] };
  return Object.entries(glossary)
    .filter(([term]) => new RegExp(`(?<!\\p{L})${escapeRegExp(term)}(?!\\p{L})`, 'u').test(source))
    .filter(([, target]) => !containsInflected(lang, translation, target))
    .map(([term, target]) => `${term} -> ${target}`);
}

const withoutUrls = (value: string): string => value.replace(/https?:\/\/\S+|[\w.-]+\.[a-z]{2,}\/\S*/gi, ' ');

/** A doNotTranslate name used in the source but missing (or translated) in the translation. */
export function keptNameMissing(name: string, source: string, text: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\d])${escapeRegExp(name)}(?![\\p{L}\\d])`, 'u');
  return re.test(withoutUrls(source)) && !withoutUrls(text).toLowerCase().includes(name.toLowerCase());
}

// ---------------------------------------------------------------------------------------
// Title case

const COMMON_NAMES = new Set(['iOS', 'Android', 'Apple', 'Google', 'iPhone', 'iPad', 'Mac', 'Windows', 'Linux', 'AI', 'API', 'URL', 'PDF', 'FAQ', 'OK']);

function midCapitals(text: string, source: string, names: string[]): string[] {
  const allowed = new Set([...COMMON_NAMES, ...names.flatMap(name => name.split(/\s+/))]);
  const isName = (word: string) =>
    allowed.has(word) ||
    new RegExp(`(?<!\\p{L})${escapeRegExp(word)}(?!\\p{L})`, 'u').test(source) ||
    [...allowed].some(name => name.length >= 4 && word.startsWith(name));
  return text
    .split(/[.!?:—–\n•|]+/)
    .flatMap(segment => {
      const words = segment.trim().split(/\s+/);
      const first = words.findIndex(word => /\p{L}/u.test(word));
      return first === -1 ? [] : words.slice(first + 1);
    })
    .map(word => word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter(word => word.length >= 3 && /^\p{Lu}\p{Ll}/u.test(word) && !isName(word));
}

function isEnglishTitleCase(source: string): boolean {
  const rest = source
    .split(/\s+/)
    .slice(1)
    .map(word => word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter(word => word.length >= 2);
  if (rest.length === 0) return false;
  return rest.filter(word => /^\p{Lu}/u.test(word)).length / rest.length >= 0.6;
}

// ---------------------------------------------------------------------------------------
// Untranslated and partial

/** `text` equals `source` and the source is prose of 3+ words (not a name, code or "OK"). */
export function isUnchangedProse(source: string, text: string, placeholderRe: RegExp): boolean {
  if (text.trim() !== source.trim() || source.length <= 15) return false;
  const words = source.replace(placeholderRe, ' ').split(/\s+/).filter(w => /\p{L}{2}/u.test(w));
  return words.length >= 3;
}

const plainWords = (value: string): string[] =>
  value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\([^)]*\d{4}[^)]*\)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * First run of six ordinary source words (at most one capitalised, so titles of works stay
 * allowed) copied into the translation, or null.
 */
export function sourceRun(source: string, text: string): string | null {
  const runs = new Set<string>();
  const sourceWords = plainWords(source);
  for (let i = 0; i + 6 <= sourceWords.length; i++) {
    const run = sourceWords.slice(i, i + 6);
    const capitalised = run.filter(word => /^[A-Z(]/.test(word)).length;
    const plain = run.filter(word => /^[a-z]{2,}$/.test(word)).length;
    if (capitalised <= 1 && plain >= 4) runs.add(run.join(' ').toLowerCase());
  }
  if (runs.size === 0) return null;
  const textWords = plainWords(text);
  for (let i = 0; i + 6 <= textWords.length; i++) {
    const run = textWords.slice(i, i + 6).join(' ').toLowerCase();
    if (runs.has(run)) return run;
  }
  return null;
}

/** A bold lead-in ("<strong>Quick setup.</strong> …") left untranslated. */
function sourceBoldLeadIn(source: string, text: string, names: string[]): string | null {
  const bold = (value: string) => [...value.matchAll(/<(?:strong|b)>(.*?)<\/(?:strong|b)>/g)].map(m => m[1].trim());
  const translated = new Set(bold(text));
  for (const lead of bold(source)) {
    if (lead.length <= 15 || !/\p{Ll}{3}/u.test(lead) || names.some(name => lead.includes(name))) continue;
    if (translated.has(lead)) return lead;
  }
  return null;
}

// Loanwords commonly written in Latin script inside non-Latin text.
const LATIN_LOANWORDS = new Set(['email', 'online', 'offline', 'emoji', 'smartphone', 'podcast', 'podcasts', 'wifi', 'blog', 'login', 'like', 'likes']);

/** Source-language words left inside a non-Latin-script translation ("Settings → Privacy"). */
function englishInNativeScript(lang: string, source: string, text: string, placeholderRe: RegExp): string | null {
  const base = baseLanguage(lang);
  // Greek writes many anglicisms in Latin script; not checked.
  if (!NATIVE_SCRIPTS[base] || base === 'el' || base === 'sr' || text === source) return null;
  const strip = (value: string) =>
    withoutUrls(value.replace(/[\w.+-]+@[\w.-]+/g, ' ').replace(/<[^>]+>/g, ' '))
      .replace(placeholderRe, ' ')
      .replace(/[(（][^)）]*[)）]/g, ' ')
      .replace(/["“„«「『‘'][^"”“»」』’']*["”“»」』’']/g, ' ');
  const sourceWords = new Set(strip(source).match(/\b[a-z]{4,}\b/g) ?? []);
  const left = [
    ...new Set(
      (strip(text).match(/(?<![\p{L}-])[a-z]{4,}(?![\p{L}])/gu) ?? []).filter(
        word => sourceWords.has(word) && !LATIN_LOANWORDS.has(word)
      )
    ),
  ];
  const menu = /\b[A-Z][a-z]+ → [A-Z][a-z]+/.exec(text);
  if (menu && source.includes(menu[0])) return `menu path left in the source language: "${menu[0]}"`;
  return left.length >= 2 ? `source words left in: ${left.slice(0, 5).join(', ')}` : null;
}

/**
 * Words that keep the hedge of English "tend(s) to". When the source has "tend to" and the
 * translation none of these, a tendency became a certainty.
 */
const HEDGE_MARKERS: Record<string, RegExp> = {
  de: /tendenziell|neig|eher|oft|meist|häufig|gewöhnlich|in der Regel|Tendenz|tendier|gern|typischerweise|leicht|normalerweise|im Schnitt|durchschnittlich/iu,
  fr: /tendance|tend|souvent|généralement|plutôt|en général|habituellement|d'ordinaire|fréquemment|facilement/iu,
  es: /tiende|tienden|suele|suelen|soler|a menudo|generalmente|por lo general|tendencia|con frecuencia|normalmente|facilidad/iu,
  it: /tend|spesso|di solito|in genere|solitamente|soli|frequente|facilmente|normalmente/iu,
  pt: /tend|costum|geralmente|muitas vezes|em geral|normalmente|frequente|facilmente|com frequência/iu,
  nl: /neig|vaak|meestal|doorgaans|over het algemeen|gewoonlijk|tend|veelal|vaker|snel|gemiddeld/iu,
  da: /tendens|tender|ofte|typisk|plejer|gerne|som regel|normalt|oftest|let/iu,
  no: /tendens|ofte|typisk|pleier|gjerne|som regel|vanligvis|oftest|lett/iu,
  nb: /tendens|ofte|typisk|pleier|gjerne|som regel|vanligvis|oftest|lett/iu,
  sv: /tender|tenden|ofta|brukar|typiskt|vanligtvis|vanligen|gärna|i regel|oftast|lätt/iu,
  ro: /tind|tinz|adesea|de obicei|deseori|în general|tendință|des|frecvent|ușor/iu,
  ru: /склон|обычно|часто|чаще|как правило|тенденц|правило|нередко|легко/iu,
  uk: /схиль|зазвичай|часто|частіше|як правило|тенденц|нерідко|легко|властив/iu,
  pl: /zwykle|często|zazwyczaj|skłon|tendencj|na ogół|bywa|częściej|łatwo|przeważnie/iu,
  cs: /tendenc|obvykle|často|zpravidla|většinou|bývá|sklon|snadno|častěji|mív/iu,
  sk: /tendenc|obvykle|často|zvyčajne|väčšinou|býva|sklon|ľahko|častejšie|zvyk|skôr/iu,
  el: /τείν|συχνά|συνήθως|τάση|συνήθ|εύκολα|συχνότερα/iu,
  fi: /taipu|usein|yleensä|tapaa|tavallisesti|tuppaa|tyypillisesti|taipumus|helposti|useimmiten|herkästi/iu,
  ca: /tendeix|tendència|sol|sovint|generalment|acostum|normalment|fàcilment|freqüent/iu,
};

function droppedHedge(lang: string, source: string, text: string): boolean {
  const markers = HEDGE_MARKERS[baseLanguage(lang)];
  return Boolean(markers) && /\btends? to\b/i.test(source) && !markers.test(text);
}
