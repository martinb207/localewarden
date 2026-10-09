/**
 * Placeholder handling. A translated, renamed or dropped placeholder ("{heures}" for
 * "{hours}") breaks at runtime: the app cannot fill it and shows the raw braces. Such a
 * translation is never written.
 */

export const DEFAULT_PLACEHOLDER_PATTERNS = [
  '\\{\\{\\s*[\\w.-]+\\s*\\}\\}', // {{name}}       i18next, Handlebars, vue-i18n
  '\\{\\s*[\\w.-]+\\s*\\}', //        {name}         ICU, react-intl, i18next (custom)
  '%(?:\\d+\\$)?[-+0#]*\\d*(?:\\.\\d+)?[sdifuxXeEgGc@]', // %s %d %1$s %.2f  printf, Android, iOS
  '%\\([\\w.-]+\\)[sdif]', //        %(name)s       Python
  '%\\{[\\w.-]+\\}', //               %{name}        Ruby, rails-i18n
  '\\$\\{[\\w.-]+\\}', //             ${name}        template literals
  '</?\\d+/?>', //                    <0>…</0>       react-i18next <Trans>
];

export function placeholderRegExp(patterns: string[] = DEFAULT_PLACEHOLDER_PATTERNS): RegExp {
  return new RegExp(patterns.map(p => `(?:${p})`).join('|'), 'g');
}

const ICU_COMPLEX = /\{\s*[\w.-]+\s*,\s*(?:plural|select|selectordinal)\s*,/;

/**
 * Argument names of an ICU MessageFormat string. Branch keys ("one", "male", "=0") and
 * the text inside branches are not arguments, so the plural categories may differ between
 * languages (Polish needs "few" and "many") without a mismatch.
 */
export function icuArguments(text: string): string[] {
  const names = new Set<string>();
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const readToken = (): string => {
    skipSpace();
    const start = i;
    while (i < text.length && !/[\s,{}]/.test(text[i])) i++;
    return text.slice(start, i);
  };
  // Parses a message until an unmatched "}" (or the end) at the current depth.
  const message = (): void => {
    while (i < text.length) {
      const ch = text[i];
      if (ch === "'" && text[i + 1] === "'") {
        i += 2;
      } else if (ch === "'" && /[{}#|]/.test(text[i + 1] ?? '')) {
        const end = text.indexOf("'", i + 1);
        i = end === -1 ? text.length : end + 1;
      } else if (ch === '{') {
        i++;
        argument();
      } else if (ch === '}') {
        return;
      } else {
        i++;
      }
    }
  };
  const argument = (): void => {
    const name = readToken();
    if (name) names.add(name);
    skipSpace();
    if (text[i] === '}') {
      i++;
      return;
    }
    if (text[i] !== ',') return;
    i++;
    const type = readToken();
    skipSpace();
    if (type === 'plural' || type === 'select' || type === 'selectordinal') {
      if (text[i] === ',') i++;
      while (i < text.length) {
        skipSpace();
        if (text[i] === '}') {
          i++;
          return;
        }
        const selector = readToken();
        skipSpace();
        if (selector.startsWith('offset:')) continue;
        if (text[i] !== '{') return;
        i++;
        message();
        if (text[i] === '}') i++;
      }
      return;
    }
    // number/date/time with an optional style: skip to the closing brace.
    let depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') depth--;
      i++;
    }
  };
  message();
  return [...names].sort();
}

/** Sorted, de-duplicated placeholder set of a string. */
export function placeholderSignature(text: string, re: RegExp): string {
  if (ICU_COMPLEX.test(text)) return icuArguments(text).map(name => `{${name}}`).join(',');
  return [...new Set((text.match(re) ?? []).map(p => p.replace(/\s/g, '')))].sort().join(',');
}

/**
 * Whether a translation keeps the placeholders of its source. Plural keys (i18next
 * "item_one" / "item_other") always receive {{count}}, so a translation may show the count
 * where the English form does not ("One item" vs "{{count}} elementy").
 */
export function placeholdersMatch(key: string, source: string, translation: string, re: RegExp): boolean {
  const isPluralKey = /_(zero|one|two|few|many|other)$/.test(key);
  const normalize = (text: string) =>
    placeholderSignature(text, re)
      .split(',')
      .filter(p => !(isPluralKey && /^\{\{?count\}?\}$/.test(p)))
      .join(',');
  return normalize(source) === normalize(translation);
}

export const PLACEHOLDER_INSTRUCTION =
  ' PLACEHOLDERS: placeholders such as {count}, {{name}}, %s, %1$d, %{name} or <0>…</0> are filled in by the software. Copy every placeholder exactly as written; never translate, rename, add or drop one. In ICU messages ({count, plural, one {…} other {…}}) keep the argument names and keywords unchanged, translate only the text inside the branches, and add the plural categories the target language needs (e.g. few, many).';
