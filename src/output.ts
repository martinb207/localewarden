/**
 * Cleaning model answers. Models sometimes wrap a translation in commentary ("Here is the
 * translation:"), code fences or quotes. That is stripped before the checks run; anything
 * left over is caught by them.
 */

// "Here is the translation:" anywhere at the start; a bare "Translation:" only when it stands on
// its own line, so a string that really starts with "Translation: …" is left alone.
const LEAD_IN =
  /^\s*(?:(?:sure|certainly|of course)[,!.]?\s*)?(?:here(?:'s| is) (?:the|your|my) (?:translation|translated text)(?: in [^:\n]+)?\s*:\s*\n*|(?:translation|translated text)\s*:[ \t]*\n+)/i;

/** A model answer with lead-in commentary, code fences and wrapping quotes removed. */
export function cleanOutput(source: string, text: string): string {
  let out = text.trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(out);
  if (fenced && !source.includes('```')) out = fenced[1].trim();
  // Never strip what the source itself says.
  if (!LEAD_IN.test(source)) out = out.replace(LEAD_IN, '');
  const quoted = /^(["“«„「])([\s\S]*)(["”»“」])$/.exec(out);
  const sourceQuoted = /^\s*["“«„「]/.test(source) && /["”»“」]\s*$/.test(source);
  if (quoted && !sourceQuoted && !quoted[2].includes(quoted[1])) out = quoted[2].trim();
  return out;
}

/**
 * A JSON array of `expected` elements from a model answer, or null. An element that is not a
 * string or number (null, an object) is returned as null: that string is translated again on
 * its own instead of becoming the text "null".
 */
export function parseArray(raw: string, expected: number): (string | null)[] | null {
  const json = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== expected) return null;
    return parsed.map(value => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null));
  } catch {
    return null;
  }
}

/**
 * Splits a long text into chunks of at most `max` characters at paragraph breaks (or line
 * breaks, if a paragraph is longer). The separators are kept so joining restores the layout.
 */
export function splitLongText(text: string, max: number): { parts: string[]; separators: string[] } {
  // Paragraph breaks first; a single paragraph longer than `max` is split at line breaks.
  const byParagraph = text.split(/(\n\s*\n)/);
  const pieces: string[] = [];
  for (let i = 0; i < byParagraph.length; i += 2) {
    const paragraph = byParagraph[i];
    const lines = paragraph.length > max ? paragraph.split(/(\n)/) : [paragraph];
    pieces.push(...lines);
    if (i + 1 < byParagraph.length) pieces.push(byParagraph[i + 1]);
  }
  const parts: string[] = [];
  const separators: string[] = [];
  let current = '';
  let pendingSeparator = '';
  for (let i = 0; i < pieces.length; i += 2) {
    const paragraph = pieces[i];
    const separator = pieces[i + 1] ?? '';
    if (current && (current + pendingSeparator + paragraph).length > max) {
      parts.push(current);
      separators.push(pendingSeparator);
      current = paragraph;
    } else {
      current = current ? current + pendingSeparator + paragraph : paragraph;
    }
    pendingSeparator = separator;
  }
  if (current) parts.push(current);
  return { parts, separators };
}
