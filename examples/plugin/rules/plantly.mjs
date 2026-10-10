/**
 * Example plugin for the Plantly app. Shows each hook once:
 *
 *   checks       a competitor name must never appear in a translation (error: never written),
 *                and Spanish "coger" (vulgar in much of Latin America) is flagged as fixable
 *   promptNotes  neutral Spanish for one text that serves Spain and Latin America
 *   postProcess  French non-breaking space before ? ! : ;
 *   order        translate the home screen first
 */
export default (options = {}) => {
  const forbidden = options.forbiddenNames ?? [];
  return {
    name: 'plantly',

    checks: ({ lang, text }) => {
      const issues = [];
      // Whole word and case-sensitive: a name like "Planta" would otherwise block every
      // Spanish sentence about "plantas".
      for (const name of forbidden) {
        const re = new RegExp(`(?<![\\p{L}\\d])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'u');
        if (re.test(text)) issues.push({ check: 'competitor-name', severity: 'error', note: `mentions "${name}"` });
      }
      if (lang === 'es' && /(?<!\p{L})(coger|coge|cogí|cogido)(?!\p{L})/iu.test(text)) {
        issues.push({ check: 'regional-term', note: '"coger" is vulgar in much of Latin America; use "tomar"', fixable: true });
      }
      return issues;
    },

    promptNotes: ({ lang }) =>
      lang === 'es'
        ? 'NEUTRAL SPANISH: one text serves Spain and Latin America. Never use "coger" (use "tomar" or "agarrar"); address groups with "ustedes", never "vosotros".'
        : '',

    postProcess: ({ lang, text }) => (lang === 'fr' ? text.replace(/ ([?!:;])/g, ' $1') : text),

    order: files => [...files].sort((a, b) => (a.id.includes('home') ? -1 : b.id.includes('home') ? 1 : 0)),
  };
};
