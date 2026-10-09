import type { Config, Register } from './config.js';
import { baseLanguage, isTraditionalChinese } from './util.js';

/**
 * Per-language rules. Each rule exists because models get it wrong without being told:
 * they mix formal and informal address between batches, copy English Title Case, default
 * to masculine forms for "you", and keep English typography.
 */

// JS \b is ASCII-only, so words with accents or non-Latin letters need \p{L} lookarounds.
const words = (list: string): RegExp => new RegExp(`(?<!\\p{L})(?:${list})(?!\\p{L})`, 'iu');

// Formal pronouns that are capitalised mid-sentence (German "Sie", Italian "Lei"). At the
// start of a sentence the capital proves nothing ("Sie" may mean "they").
const midSentence = (list: string): RegExp =>
  new RegExp(`(?<![.!?:•>\\n]\\s*|^\\s*|\\p{L})(?:${list})(?!\\p{L})`, 'u');

interface AddressForm {
  instruction: string;
  pattern: RegExp;
}

export interface FormalityRule {
  formal: AddressForm;
  informal: AddressForm;
}

/** Quoted speech is ignored when judging the form of address ("say to your child: ..."). */
export const withoutQuotedSpeech = (text: string): string =>
  text.replace(/"[^"]*"|“[^”]*”|«[^»]*»|„[^“”]*[“”]|「[^」]*」/g, ' ');

export const FORMALITY_RULES: Record<string, FormalityRule> = {
  fr: {
    formal: {
      instruction: 'Address the user with "vous" everywhere (vous/votre/vos, imperatives ending in -ez). Never use "tu", "toi", "ton", "ta", "tes" or tu-imperatives.',
      pattern: words('vous|votre|vos'),
    },
    informal: {
      instruction: 'Address the user with "tu" everywhere (tu/toi/ton/ta/tes, tu-imperatives). Never use "vous" for the user.',
      // "ton" after an article is the noun "tone" ("le ton").
      pattern: new RegExp(
        `${words('tu|toi|ta|tes|te').source}|(?<!\\p{L})(?<!(?:le|un|du|au|ce|de) )ton(?!\\p{L})|-toi(?!\\p{L})|(?<!\\p{L})t['’](?=[aeiouyhéèêà])`,
        'iu'
      ),
    },
  },
  de: {
    formal: {
      instruction: 'Address the user with "Sie" everywhere (Sie/Ihnen/Ihr), never with "du".',
      pattern: midSentence('Sie|Ihnen|Ihre|Ihren|Ihrem|Ihrer|Ihres'),
    },
    informal: {
      instruction: 'Address the user with "du" everywhere (du/dich/dir/dein), never with "Sie"/"Ihnen"/"Ihr".',
      pattern: words('du|dich|dir|dein|deine|deinen|deinem|deiner|deines'),
    },
  },
  es: {
    formal: {
      instruction: 'Address the user with "usted" everywhere (usted/su/le), never with "tú".',
      pattern: words('usted|ustedes'),
    },
    informal: {
      instruction: 'Address the user with "tú" everywhere (tú/tu/te/ti), never with "usted".',
      pattern: words('tú|tu|tus|te|ti|contigo|tuyo|tuya'),
    },
  },
  it: {
    formal: {
      instruction: 'Address the user with the formal "Lei" everywhere (Lei/Suo/Sua), never with "tu".',
      pattern: midSentence('Lei|Suo|Sua|Suoi|Sue'),
    },
    informal: {
      instruction: 'Address the user with "tu" everywhere (tu/ti/tuo/tua), never with the formal "Lei".',
      pattern: words('tu|tuo|tua|tuoi|tue|ti'),
    },
  },
  pt: {
    formal: {
      instruction: 'Address the user with "você" (você/seu/sua), never with "tu"/"teu"/"tua".',
      pattern: words('você|vocês'),
    },
    informal: {
      instruction: 'Address the user with "tu" (tu/teu/tua), never with "você".',
      pattern: words('tu|teu|tua|teus|tuas|contigo'),
    },
  },
  nl: {
    formal: {
      instruction: 'Address the user with "u/uw" everywhere, never with "je/jij/jouw".',
      // "u." is an initial or "U.S.", "3u" is hours — not the pronoun.
      pattern: words('(?<!\\d)u(?!\\.)|uw|uzelf'),
    },
    informal: {
      instruction: 'Address the user with "je/jij/jouw" everywhere, never with "u/uw".',
      pattern: words('je|jij|jouw|jou|jezelf'),
    },
  },
  ru: {
    formal: {
      instruction: 'Address the user with "вы" everywhere (вы/вас/вам/ваш), never with "ты"/"твой".',
      pattern: words('вы|вас|вам|вами|ваш|ваша|ваше|ваши|вашего|вашей|ваших|вашим|вашими|вашу'),
    },
    informal: {
      instruction: 'Address the user with "ты" everywhere (ты/тебя/тебе/твой), never with "вы".',
      pattern: words('ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои|твоего|твоей|твоих|твоим|твоими|твою'),
    },
  },
  uk: {
    formal: {
      instruction: 'Address the user with "ви" everywhere (ви/вас/вам/ваш), never with "ти"/"твій".',
      pattern: words('ви|вас|вам|вами|ваш|ваша|ваше|ваші|вашого|вашої|ваших|вашим|вашу'),
    },
    informal: {
      instruction: 'Address the user with "ти" everywhere (ти/тебе/тобі/твій), never with "ви".',
      pattern: words('ти|тебе|тобі|тобою|твій|твоя|твоє|твої|твого|твоєї|твоїх|твоїм|твою'),
    },
  },
  cs: {
    formal: {
      instruction: 'Address the user with "vy" everywhere (vy/vás/vám/váš, verbs in 2nd person plural), never with "ty"/"tvůj".',
      pattern: words('vy|vás|vám|vámi|váš|vaše|vaši|vašeho|vašich|vaší|vašim|jste'),
    },
    informal: {
      instruction: 'Address the user with "ty" everywhere (tě/tebe/tvůj, verbs in 2nd person singular), never with "vy".',
      // Not "ty": it is also the demonstrative "those".
      pattern: words('tebe|tě|tobě|tebou|tvůj|tvoje|tvá|tvé|tvého|tvých|tvým|tvou|jsi'),
    },
  },
  sk: {
    formal: {
      instruction: 'Address the user with "vy" everywhere (vy/vás/vám/váš, verbs in 2nd person plural), never with "ty"/"tvoj".',
      pattern: words('vy|vás|vám|vami|váš|vaša|vaše|vášho|vašich|vašej|vašu'),
    },
    informal: {
      instruction: 'Address the user with "ty" everywhere (teba/tvoj, verbs in 2nd person singular), never with "vy".',
      pattern: words('ty|teba|ťa|tebe|tebou|tvoj|tvoja|tvoje|tvojho|tvojich|tvojim'),
    },
  },
  pl: {
    formal: {
      instruction: 'Address the user formally with "Pan/Pani" or neutral impersonal forms, never with "ty"/"twój".',
      pattern: words('pan|pani|państwo|pana|panu|panią|państwa'),
    },
    informal: {
      instruction: 'Address the user informally with "ty" (verbs in 2nd person singular, twój/twoja), never with "Pan"/"Pani"/"Państwo".',
      pattern: words('ty|ciebie|cię|tobie|tobą|twój|twoja|twoje|twojego|twoich|twoim|twoją|twojej'),
    },
  },
  ro: {
    formal: {
      instruction: 'Address the user with "dumneavoastră" (dvs.) everywhere, never with "tu".',
      pattern: words('dumneavoastră|dvs'),
    },
    informal: {
      instruction: 'Address the user informally with "tu" (tu/tine/tău/ta), never with "dumneavoastră".',
      pattern: words('tu|tine|tău|tale|tăi|îți'),
    },
  },
  ca: {
    formal: {
      instruction: 'Address the user with "vostè" everywhere, never with "tu".',
      pattern: words('vostè|vostès'),
    },
    informal: {
      instruction: 'Address the user with "tu" everywhere (tu/et/teu/teva), never with "vostè".',
      pattern: words('tu|teu|teva|teus|teves'),
    },
  },
  id: {
    formal: {
      instruction: 'Address the user with "Anda" everywhere, never with "kamu", "kau" or the suffix "-mu".',
      pattern: words('anda'),
    },
    informal: {
      instruction: 'Address the user with "kamu" everywhere, never with "Anda".',
      pattern: words('kamu|kau|dirimu|milikmu'),
    },
  },
  ms: {
    formal: {
      instruction: 'Address the user with "anda" everywhere, never with "kamu", "awak" or "engkau".',
      pattern: words('anda'),
    },
    informal: {
      instruction: 'Address the user with "awak" or "kamu" consistently, never with "anda".',
      pattern: words('kamu|awak|engkau'),
    },
  },
  hr: {
    formal: {
      instruction: 'Address the user with "vi" everywhere (vi/vas/vama/vaš, verbs in 2nd person plural), never with "ti".',
      pattern: words('vi|vas|vama|vaš|vaša|vaše|vašu|vašim|možete|želite|trebate|imate|znate'),
    },
    informal: {
      instruction: 'Address the user with "ti" everywhere (tebe/tvoj, verbs in 2nd person singular), never with "vi".',
      // Not "ti": it is also the demonstrative "those".
      pattern: words('tebe|tebi|tvoj|tvoja|tvoje|tvoju|tvojim|možeš|želiš|trebaš|imaš|znaš'),
    },
  },
  sl: {
    formal: {
      instruction: 'Address the user with "vi" everywhere (vi/vas/vam/vaš, verbs in 2nd person plural), never with "ti".',
      pattern: words('vi|vas|vam|vaš|vaša|vaše|vašo|želite|morate|veste|imate|lahko ste'),
    },
    informal: {
      instruction: 'Address the user with "ti" everywhere (tebe/tvoj, verbs in 2nd person singular), never with "vi".',
      // Not "ti": it is also the demonstrative "these/those".
      pattern: words('tebe|tebi|tvoj|tvoja|tvoje|tvojo|želiš|moraš|veš|imaš|lahko si'),
    },
  },
  tr: {
    formal: {
      instruction: 'Address the user with "siz" everywhere (siz/sizin/size, verbs ending in -siniz/-sınız/-in/-ın), never with "sen".',
      pattern: words('siz|sizi|size|sizin|sizde|sizden'),
    },
    informal: {
      instruction: 'Address the user with "sen" everywhere (sen/senin/sana), never with "siz".',
      pattern: words('sen|seni|sana|senin|sende|senden'),
    },
  },
  el: {
    formal: {
      instruction: 'Address the user formally with "εσείς" everywhere (σας, verbs in 2nd person plural), never with "εσύ"/"σου".',
      pattern: words('εσείς|σας|μπορείτε|θέλετε|έχετε|κάνετε|νιώθετε|ξέρετε'),
    },
    informal: {
      instruction: 'Address the user informally with "εσύ" everywhere (σου, verbs in 2nd person singular), never with "εσείς"/"σας".',
      pattern: words('εσύ|σου|μπορείς|θέλεις|έχεις|κάνεις|νιώθεις|ξέρεις'),
    },
  },
};

export const formalityRule = (lang: string): FormalityRule | undefined =>
  FORMALITY_RULES[baseLanguage(lang)];

/** Configured register for a language: exact code first ("pt-BR"), then base ("pt"). */
export function registerFor(config: Config, lang: string): Register | undefined {
  return config.formality[lang] ?? config.formality[baseLanguage(lang)];
}

/**
 * Languages that write headings and buttons in sentence case. German is left out because it
 * capitalises nouns; Indonesian, Malay, Tagalog, Swahili and Turkish because Title Case
 * headings are common enough there.
 */
export const SENTENCE_CASE_LANGUAGES = new Set([
  'fr', 'es', 'it', 'pt', 'ca', 'nl', 'sv', 'no', 'nb', 'nn', 'da', 'fi', 'pl', 'cs', 'sk',
  'sl', 'hr', 'hu', 'ro', 'ru', 'uk', 'el', 'bg', 'sr', 'et', 'lv', 'lt',
]);

/**
 * Languages where verbs, participles or adjectives agree with the gender of "you". English
 * never marks it, so without instruction the model defaults to masculine.
 */
export const GENDERED_ADDRESS_LANGUAGES = new Set([
  'ru', 'uk', 'pl', 'cs', 'sk', 'sl', 'hr', 'sr', 'bg', 'ro', 'fr', 'es', 'it', 'pt', 'ca',
  'el', 'he', 'ar', 'hi',
]);

/** Languages where "&" in running text reads as an untranslated English habit. */
export const NO_AMPERSAND_LANGUAGES = new Set(['fr', 'es', 'it', 'pt', 'ca', 'ro']);

/** Languages that put a space between a number and the percent sign. */
const PERCENT_SPACED = new Set(['de', 'fr', 'sv', 'fi', 'cs', 'sk', 'no', 'nb', 'da']);

// Adverbs, gerunds and nouns that follow "you are" but carry no gender.
const NOT_GENDERED =
  '(?!\\p{L}*(?:mente|ment|ndo|ent)(?!\\p{L}))(?!(?:tanto|respecto|dopo|peggio|meglio|meno|davvero|affatto|mieux|maintenant|pendant|quelqu|enquanto|solo|stato|sentito|chiesto|nato)(?!\\p{L}))';

/** "you are / you feel" (+ up to two adverbs) + a word with a masculine ending. */
function youAreMasculine(verbs: string, adverbs: string, endings: string): RegExp {
  return new RegExp(
    `(?<!\\p{L})(?:${verbs})\\s+(?:(?:${adverbs})\\s+){0,2}${NOT_GENDERED}\\p{L}{2,}(?:${endings})(?!\\p{L})`,
    'iu'
  );
}

/**
 * Masculine-only forms addressed to the user. Deliberately narrow (mostly "you are/feel" +
 * participle or adjective) to keep false positives low; reported as "formality" findings.
 */
export const GENDERED_FORMS: Record<string, RegExp> = {
  pl: new RegExp(
    [
      '\\p{L}+łeś(?!\\p{L})',
      '(?<!\\p{L})jesteś\\s+(?:(?:całkowicie|bardzo|zbyt|tak|naprawdę|już)\\s+){0,2}\\p{L}{2,}(?:ony|any|ęty|ąty|ący|ały|aty|yty|ity)(?!\\p{L})',
    ].join('|'),
    'iu'
  ),
  el: /(?<!\p{L})είσαι\s+(?:\p{L}+\s+){0,2}(?!εκτός)\p{L}{2,}(?:ός|ής)(?!\p{L})/iu,
  hr: /\p{L}+[aiue]o si(?!\p{L})|(?<!\p{L})si \p{L}+[aiue]o(?!\p{L})/iu,
  sl: /(?<!\p{L})si \p{L}{2,}il(?!\p{L})|\p{L}{2,}il si(?!\p{L})/iu,
  es: youAreMasculine(
    'estás|estés|estarás|te sientes|te sientas|te sentirás|eres|te pones|te quedas|no estás|no eres|te sentiste|te has sentido|estuviste|has estado|fuiste',
    'muy|más|tan|algo|un poco|demasiado|menos|bastante|completamente|totalmente|realmente|siempre|todavía',
    'ado|ido|oso|ivo|ero|ico|isto|ierto|to'
  ),
  // "você" only: a bare "está associado" is usually "it is linked".
  pt: youAreMasculine(
    'você está|você estiver|você fica|você ficar|você é|você se sente|você não é|você não está|você foi|você se sentiu|você ficou|você esteve',
    'muito|mais|tão|meio|menos|bem|completamente|totalmente|realmente|sempre',
    'ado|ido|oso|ivo|eiro|onto|cho|rso|aco|uso'
  ),
  it: new RegExp(
    [
      youAreMasculine(
        'sei|ti senti|ti sentirai|sarai|ti ritrovi|ti sei|resti|rimani|non sei',
        "molto|più|così|troppo|meno|un po'|davvero|completamente|mai|sempre",
        'ato|uto|ito|oso|ivo|ico|nto|esso|atto|otto|anco|ronto|curo|rso|orto|olo'
      ).source,
      '(?<!\\p{L})(?:ti\\s+sei\\s+(?:sentito|stato|dato|trovato|perso|chiesto)|sei\\s+(?:stato|nato|rimasto))(?!\\p{L})',
    ].join('|'),
    'iu'
  ),
  fr: youAreMasculine(
    "vous êtes|vous sentez|vous serez|vous vous sentez|vous vous sentirez|êtes-vous|vous n'êtes|n'êtes|soyez|vous restez|tu es|tu te sens|es-tu",
    'très|plus|si|trop|moins|un peu|bien|jamais|pas|complètement|vraiment|toujours|aussi',
    'é|i|u|eux|if|ant|is|eul|ûr|er'
  ),
  ca: youAreMasculine(
    "estàs|et sents|ets|estaràs|et sentiràs|no estàs|has estat|t'has sentit",
    'molt|més|tan|massa|menys|mai|completament|realment',
    'at|it|ut|ós|iu'
  ),
  ro: youAreMasculine(
    'ești|te simți|vei fi|te vei simți|să fii|nu ești|ai fost|te-ai simțit',
    'foarte|mai|prea|puțin|complet|niciodată',
    'at|it|ut|os|iv|ent|il'
  ),
  // Masculine singular "you" in Hebrew, including prefixed forms.
  he: /(?<![֐-׿])(?:ו|ש|כש|וכש|כ|מ|ה)?אתה(?![֐-׿])/u,
};

/**
 * Notes added to the prompt for every string in a language. Built from the config and the
 * built-in typography rules.
 */
export function styleInstruction(config: Config, lang: string): string {
  const base = baseLanguage(lang);
  const parts: string[] = [];

  const register = registerFor(config, lang);
  const rule = formalityRule(lang);
  if (register && rule) {
    parts.push(`FORM OF ADDRESS: ${rule[register].instruction} Be consistent across every string.`);
    if (register === 'formal') {
      parts.push(
        'Words in quotation marks that someone says to a partner, child or friend use the informal form people really use with each other; the formal form is only for addressing the reader. Commands to the reader use the formal imperative too, also in headings and buttons without a pronoun.'
      );
    }
  } else if (register) {
    parts.push(`FORM OF ADDRESS: address the user in the ${register} register everywhere and be consistent across every string.`);
  }

  if (config.sentenceCase && SENTENCE_CASE_LANGUAGES.has(base)) {
    parts.push(
      'CAPITALIZATION: English UI often uses Title Case ("Set Up Your Account"); do NOT copy it. Use sentence case: capitalize only the first word and proper nouns.'
    );
  }

  if (config.genderNeutral && GENDERED_ADDRESS_LANGUAGES.has(base)) {
    parts.push(
      'GENDER: the user\'s gender is unknown. Never use a gendered form for the user (past-tense verbs, participles or adjectives about "you"); rephrase neutrally with present tense, infinitives, nouns or plural-polite forms. Do not default to masculine. Feelings and states of the reader become nouns ("you feel anxious" -> es "sientes ansiedad", not "te sientes ansioso"). The same applies to first-person sentences the user is meant to say or think ("I feel ready").'
    );
    if (base === 'he') {
      parts.push(
        'HEBREW ADDRESS: address the reader in the plural (אתם, לכם, שלכם, plural verbs and imperatives), which is gender-neutral; never the masculine singular אתה or singular imperatives.'
      );
    }
  }

  if (NO_AMPERSAND_LANGUAGES.has(base)) {
    parts.push('Write "and" as a word in the target language; never use "&".');
  }
  if (PERCENT_SPACED.has(base)) {
    parts.push('PERCENT: write a space before the percent sign ("92 %"), never "92%".');
  }
  if (base === 'fr') {
    parts.push('French typography: put a non-breaking-style space before "?", "!", ":" and ";".');
  }
  if (base === 'de') {
    parts.push('German: English loanwords used as nouns are capitalised like every German noun.');
  }
  if (base === 'zh' || base === 'ja') {
    const marks = base === 'ja' || isTraditionalChinese(lang) ? '「…」' : '“…”';
    parts.push(`QUOTATION MARKS: quote text with ${marks}, never with ASCII "…" (HTML attributes keep their ASCII quotes).`);
  }
  if (base === 'ko') {
    parts.push(
      'SPEECH LEVEL: always polite. Explanations use 합니다체 (-습니다/-ㅂ니다); short UI texts may use 해요체 (-요). Never use plain style (-다) addressed to the reader, and do not switch speech level within one text.'
    );
  }

  const glossary = { ...config.glossary[base], ...config.glossary[lang] };
  const entries = Object.entries(glossary);
  if (entries.length > 0) {
    parts.push(
      `GLOSSARY (use these renderings, inflected as the grammar of the sentence requires): ${entries
        .map(([source, target]) => `"${source}" -> "${target}"`)
        .join('; ')}.`
    );
  }

  for (const scope of new Set(['*', base, lang])) {
    const extra = config.instructions[scope];
    if (extra) parts.push(extra);
  }
  return parts.join(' ');
}
