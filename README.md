# localewarden

[![npm](https://img.shields.io/npm/v/localewarden)](https://www.npmjs.com/package/localewarden) [![CI](https://github.com/martinb207/localewarden/actions/workflows/ci.yml/badge.svg)](https://github.com/martinb207/localewarden/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/localewarden)](LICENSE)

**Incremental AI translation for JSON locale files.** It translates only what changed, never overwrites a translation a person fixed, and checks every result before it is written.

```bash
npx localewarden init        # create a config
npx localewarden --dry-run   # see what would be translated and roughly what it costs
npx localewarden             # translate new and changed strings
npx localewarden check       # quality check, no API calls (use it in CI)
```

Works with i18next, react-intl / FormatJS, vue-i18n, next-intl, ngx-translate and any other setup that keeps strings in JSON files, with Flutter (`.arb` files) and with fastlane's App Store / Play Store metadata (`.txt` files). Uses any OpenAI-compatible API (OpenAI, OpenRouter, a local Ollama, ...).

## Why

Translating locale files with a language model is easy once. Keeping 20 languages correct while the source keeps changing is not:

- **Re-translating everything** on every change costs money and rewrites wording that was already fine.
- **Hand fixes get overwritten** by the next run.
- **Models are inconsistent across batches.** French screens mix "tu" and "vous", Spanish copies English Title Case ("Configure Su Cuenta"), and Polish or Russian address every user as a man.
- **Broken output ships silently.** A translated placeholder (`{heures}` instead of `{hours}`) shows raw braces in your app. A dropped `</strong>` breaks the layout. Stray Cyrillic letters end up in a Danish sentence.

localewarden grew out of the translation pipeline of a production app that ships in 38 languages. Every rule and check in it exists because one of these failures happened in real output. The checks are tuned against that app's real texts (UI, website, long-form learning content and store listings, about 165 MB) to report problems without flooding you with false alarms. On those texts they still find things that slipped through earlier pipelines: sections cut off after the English grew, stray letters from other alphabets, a trial notice left in English.

## How it compares

- **Translation platforms** (Crowdin, Lokalise, Phrase, Weblate) are hosted services with editors, translator workflows and review for teams. localewarden is a small CLI that runs in your repository and CI, with no account and no server. If you have professional translators, a platform fits better. If a model translates and people only fix the odd string, this is the lighter setup.
- **"Translate my JSON with GPT" scripts** usually send every string on every run and overwrite whatever is there. localewarden keeps state, so it only sends what changed, keeps human fixes, and checks the output.
- **Editor extensions** (such as i18n Ally) help you write and look up keys while coding. localewarden is about filling and maintaining 10 to 40 languages afterwards. The two work well together.

## What it does

- **Translates only what changed.** It remembers a hash of each source string per language. New strings are translated. Changed strings are *revised*: the model gets the existing translation and changes only what the source change requires. Removed strings are deleted from every language.
- **Protects hand edits.** If someone edited a translation, localewarden detects it, keeps it, and lists it for review. If the source of a hand-edited string changes later, the string is flagged instead of overwritten.
- **Checks every result before writing it.** Broken placeholders, injected HTML or scripts, foreign alphabets, changed links, broken HTML and echoed source text are rejected (retried once, then left for the next run). Softer problems (too long, content missing, words left in English) are retried and reported.
- **Consistent style per language.** It enforces formal or informal address per language (`du`/`Sie`, `tu`/`vous`, `ты`/`вы` and 16 more), uses sentence case where the language does, avoids gendered forms for "you", and applies local typography (French spacing, `92 %` in German, CJK quotation marks).
- **Plural forms per language.** For i18next-style keys (`item_one`, `item_other`) it adds the forms a language needs but English lacks, such as Polish `_few` and `_many` or Arabic `_zero`, `_two`, `_few` and `_many` (CLDR plural rules).
- **Data files and store listings.** Fields like `id`, `type` or `image` are copied instead of translated (`ignoreKeys`), and so are URLs, email addresses and file paths. Length limits per key (`maxLength`) are passed to the model and checked: App Store names, SEO titles, buttons.
- **Glossary and protected names.** You choose fixed renderings ("Privacy Policy" -> "Politique de confidentialité") and names that must never be translated. The check accepts grammatical case endings.
- **Quality check for CI.** `localewarden check` runs all checks without any API calls and exits non-zero on errors.
- **Targeted repair.** `--fix-flagged` asks the model to fix only what the check flagged. The fix is accepted only if the problem is gone and little else changed.
- **Budget control.** A token budget per run and per day (for scheduled jobs), a dry run with a cost estimate, and graceful stop and resume.
- **Groups.** Parts of a project with their own files, languages and model settings, translated in a fixed order (say app UI first, long-form content last, with a cheaper setting).
- **Plugins.** Your own checks, prompt notes, post-processing and file order, without forking.
- **Web interface.** `npx localewarden ui`: progress per language, strings with inline editing, check findings, the review list, and runs with a live log. Local only.
- **Reliable in daily use.** Lock against parallel runs, atomic writes, progress saved on Ctrl+C, Windows line endings and byte order marks kept.
- **No runtime dependencies.** Node.js 20+.

## Example

Source (`locales/en.json`) and config for a small plant-watering app:

```json
{
  "app": { "tagline": "Keep Your Plants Alive Without Thinking About It" },
  "onboarding": {
    "welcome": "Welcome to Plantly, {name}!",
    "tip": "Most houseplants tend to need less water in winter."
  },
  "reminders": { "due_other": "{{count}} plants need water today", "snooze": "Remind Me Tomorrow" },
  "settings": { "privacy": "Read our <a href=\"/privacy\">Privacy Policy</a> to see what we store." }
}
```

```json
{
  "targetLanguages": ["de", "fr", "es", "ja"],
  "files": "locales/{lang}.json",
  "context": "Plantly is a mobile app that reminds people when to water their houseplants.",
  "doNotTranslate": ["Plantly"],
  "formality": { "de": "informal", "fr": "formal", "es": "informal" },
  "glossary": { "fr": { "Privacy Policy": "Politique de confidentialité" } },
  "termNotes": { "snooze": "postpone a reminder, not sleep" }
}
```

Real output with the default model (`gpt-5.4-mini`), 4 requests, about 6,000 tokens:

```text
de  Halte deine Pflanzen am Leben, ohne daran denken zu müssen
    Die meisten Zimmerpflanzen brauchen im Winter tendenziell weniger Wasser.
    Erinnere mich morgen
fr  Gardez vos plantes en vie sans y penser
    Bienvenue sur Plantly, {name} !
    Lisez notre <a href="/privacy">Politique de confidentialité</a> pour voir ce que nous stockons.
es  Mantén vivas tus plantas sin tener que pensar en ello
    Hoy necesitan agua {{count}} plantas
ja  何も考えなくても、植物を元気に保てます
```

German uses "du" and French "vous", as configured. Spanish and French use sentence case, not the English Title Case. French has its space before "!". The hedge "tend to" survived, and so did the placeholders, the link and the brand name. The full example is in [`examples/basic`](examples/basic). There are also examples for [Flutter ARB files](examples/flutter) and [App Store / Play Store texts with fastlane](examples/fastlane).

## Quick start

1. Install, or use `npx`:

   ```bash
   npm install --save-dev localewarden
   ```

2. Create a config. `init` looks for common locale folder layouts:

   ```bash
   npx localewarden init
   ```

3. Edit `localewarden.config.json`: set `targetLanguages`, `files` and `context`.

4. Set your API key and do a dry run:

   ```bash
   export OPENAI_API_KEY=sk-...
   npx localewarden --dry-run
   ```

5. Translate, then commit the locale files **and** the `.localewarden/` folder:

   ```bash
   npx localewarden
   git add locales .localewarden
   ```

   `.localewarden/` holds the hashes that tell localewarden what changed and what was edited by hand. Commit it so your team and your CI share the same state, except two local files:

   ```gitignore
   .localewarden/usage.json
   .localewarden/run.lock
   ```

## How it decides what to translate

For every string and language:

| Situation | What happens |
| --- | --- |
| No translation yet | Translated |
| Translation exists, localewarden has never seen it (first run) | Kept as is. Your existing translations are adopted, not re-translated. Exception: a copy of the source text is translated. |
| Source changed since the last translation | Revised: the model gets the old translation and changes only what is needed |
| Translation differs from what localewarden wrote | Hand edit: kept, protected, listed in `localewarden review` |
| Hand-edited, and then the source changed | Kept and flagged for review (`source-changed`) |
| String removed from the source | Removed from the translation |
| Result fails a hard check | Not written. The string is retried on the next run. |

## Quality checks

The same checks run in two places. Right after each model answer, a failed hard check means the translation is never written. `localewarden check` runs all of them over your files without any API calls.

| Check | Finds | Severity |
| --- | --- | --- |
| `placeholder` | `{name}`, `{{count}}`, `%s`, `%1$d`, `%{x}`, `${x}`, `<0></0>` renamed, translated, added or dropped. ICU `plural`/`select` arguments are compared, while plural categories may differ per language. | error |
| `unsafe` | HTML tags, attributes, event handlers or `javascript:`/`data:` URLs that the source does not have. Translations are often rendered as raw HTML, so this would be a script injection. | error |
| `script` | Letters from an alphabet the language does not use ("刺激" in German), a word that mixes Latin with Cyrillic/Greek lookalikes ("Вarda"), or Simplified characters in Traditional Chinese (`zh-TW`) and the reverse | error |
| `markup` | Changed link targets, different number of tags, unclosed or misnested tags, dropped list items | warning (broken tags and changed links: never written) |
| `years` | A year from the source missing or changed (citations, dates) | warning |
| `formality` | The other form of address than configured, both forms in one string, or masculine-only forms for "you" | warning |
| `length` | Longer than the `maxLength` configured for the key | warning |
| `titlecase` | English Title Case copied into a language that uses sentence case | warning |
| `ampersand` | "&" in languages that write the word | warning |
| `glossary` | A glossary rendering missing (case endings allowed), or a `doNotTranslate` name translated | warning |
| `untranslated` | Identical to the source (prose of 3+ words; "OK" and names are fine) | warning |
| `partial` | Source-language words left inside the translation, an untranslated bold lead-in, a hedge that became certainty ("tend to" stated as fact), a translation much shorter than its source (content cut off, or the source grew after it was translated), or sibling options that got the same translation although the source differs ("Rarely" and "Occasionally" both "Selten") | warning |

```bash
npx localewarden check              # counts per language and check
npx localewarden check -v           # with examples
npx localewarden check --strict     # exit 1 on warnings too
npx localewarden check --json       # for scripts
npx localewarden check --fix        # repair placeholders with one possible fix, no API calls
```

`--fix` repairs a translated placeholder when the source has exactly one and the translation renamed it (`{stunden}` back to `{hours}`). The file is edited in place, so its formatting stays as it is. Anything less certain is left for `--fix-flagged` or a person.

Approved strings are skipped, except for errors (placeholder, unsafe, script), which break the app either way. You can approve any string, not only hand edits: `npx localewarden review --approve de:home.title` tells the check that a person looked at it (for example a pun on a brand name that is correct without the name), and runs leave it alone.

### In CI

```yaml
# .github/workflows/i18n.yml
name: i18n
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx localewarden check
```

### Translating automatically

When the source language changes on `main`, translate and open a pull request for review:

```yaml
# .github/workflows/translate.yml
name: translate
on:
  push:
    branches: [main]
    paths: ['locales/en.json']   # your source files
permissions:
  contents: write
  pull-requests: write
jobs:
  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx localewarden --max-tokens 200000
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - uses: peter-evans/create-pull-request@v7
        with:
          branch: localewarden/translations
          title: Update translations
          commit-message: Update translations
```

The pull request contains the locale files and `.localewarden/`, so a reviewer sees exactly which strings changed.

### Fixing what the check finds

```bash
npx localewarden --fix-flagged
```

For each flagged string, the model gets the source, the current translation and the exact findings, with the instruction to change only what is needed. The fix is written only if the same check passes afterwards, nothing else breaks, and few words changed. Rejected fixes are recorded in `.localewarden/repair-failures.json` and not retried until the translation changes.

## Web interface

```bash
npx localewarden ui            # prints a local URL with an access token
```

- **Overview:** progress per group and language, hand edits waiting for review, tokens used today.
- **Strings:** search by key, source or translation; show only missing ones; edit a translation inline. An edit counts as checked by a person: it is approved and protected from runs.
- **Check:** run the quality check and filter findings by language and check.
- **Review:** approve hand edits or hand them back.
- **Run:** dry run, translate or fix flagged strings, with a live log.

The interface listens on `127.0.0.1` only, needs the random token from the printed URL, and
rejects requests with another host name, so websites open in your browser cannot use it.
It writes only to the project's own locale files.

## Hand edits and review

```bash
npx localewarden review                       # list pending hand edits
npx localewarden review --approve de:home.title   # correct: keep it protected
npx localewarden review --approve de:*            # all German entries
npx localewarden review --release de:home.title   # hand it back: next run revises it
```

`--overwrite-manual` makes a run replace hand edits on purpose.

## Configuration

`localewarden.config.json`:

| Option | Default | Description |
| --- | --- | --- |
| `targetLanguages` | (required) | Language codes, e.g. `["de", "fr", "pt-BR", "zh-TW"]` |
| `files` | (required) | Path pattern with `{lang}`. `*` matches within one folder, `**/` any depth. Examples: `locales/{lang}.json`, `public/locales/{lang}/*.json`, `src/**/i18n/{lang}.json`, `messages.{lang}.json` |
| `sourceLanguage` | `"en"` | Language of the source files. Some checks (title case, source words left in, hedges) assume English. |
| `context` | | One or two sentences about your product. This is the most effective way to get the right meaning. |
| `tone` | | e.g. `"friendly and plain, no marketing hype"` |
| `doNotTranslate` | `[]` | Brand, product and feature names that must stay as written |
| `formality` | `{}` | `{"de": "informal", "fr": "formal"}`. Built-in rules for fr, de, es, it, pt, nl, ru, uk, cs, sk, pl, ro, ca, id, ms, hr, sl, tr, el. Other languages get a general instruction. |
| `genderNeutral` | `true` | Avoid gendered forms when addressing the user |
| `sentenceCase` | `true` | Use sentence case in languages that do not capitalise titles |
| `glossary` | `{}` | `{"fr": {"Terms of Service": "Conditions d'utilisation"}}` |
| `termNotes` | `{}` | Meanings of ambiguous terms, sent only with strings that contain them: `{"snooze": "postpone a reminder"}` |
| `instructions` | `{}` | Extra instructions per language, `"*"` for all: `{"es": "Use neutral Latin American Spanish."}` |
| `ignoreKeys` | `[]` | Keys that are not text, copied from the source: `["id", "type", "**.sources.*"]`. `*` matches within a key segment, `**` across segments; a pattern without a dot matches the last segment anywhere. URLs, emails, file paths and numbers are always copied. |
| `exclude` | `[]` | Source files to skip: `["locales/{lang}/nav.json"]` |
| `maxLength` | `{}` | Character limits per key pattern: `{"**.meta.title": 60, "name": 30}`. The model is told the limit; longer results are retried once and reported by the `length` check. |
| `placeholders` | built-in | Regular expressions (strings) that match your placeholders. Replaces the built-in list. |
| `model` | `"gpt-5.4-mini"` | Any chat model your endpoint offers |
| `baseUrl` | `"https://api.openai.com/v1"` | Any OpenAI-compatible endpoint |
| `apiKeyEnv` | `"OPENAI_API_KEY"` | Environment variable that holds the key |
| `reasoningEffort` | `"medium"` for reasoning models | `"low"` is cheaper. `"medium"` gave noticeably more natural wording in our tests. |
| `temperature` | `0.3` for other models | |
| `maxTokensPerRun` | `500000` | The run stops when the API-reported usage reaches this |
| `concurrency` | `4` | Languages translated in parallel |
| `batchSize` | `20` | Strings per request (smaller for scripts that need many tokens) |
| `stateDir` | `".localewarden"` | Where state and the review list live |
| `dailyTokenBudget` | | Token limit per UTC day across runs (for scheduled jobs); usage is kept in `<stateDir>/usage.json` (add it to `.gitignore`) |
| `copies` | `{}` | Locales that are a copy of another one instead of a translation: `{"en-GB": "en-US", "fr-CA": "fr-FR"}` |
| `chunkChars` | `8000` | Longer strings are translated paragraph by paragraph |
| `plugins` | `[]` | Plugin modules, see [Plugins](#plugins) |
| `groups` | | Parts of the project with their own settings, see [Groups](#groups) |

### Groups

Different parts of a project often need different settings: the app UI translated first and
with care, long articles last and with a cheaper setting, store listings with other locale
codes. Each group inherits the top-level settings and may override them:

```json
{
  "targetLanguages": ["de", "fr", "pl"],
  "dailyTokenBudget": 2000000,
  "groups": [
    { "name": "app", "files": "src/locales/{lang}/*.json" },
    { "name": "store", "files": "fastlane/metadata/{lang}/*.txt", "sourceLanguage": "en-US",
      "targetLanguages": ["de-DE", "fr-FR", "pl"], "copies": { "fr-CA": "fr-FR" } },
    { "name": "articles", "files": "content/*/*.{lang}.json", "reasoningEffort": "low",
      "ignoreKeys": ["id", "slug", "image"] }
  ]
}
```

Groups run in this order and share the budget, so the important ones are done first when the
budget runs out. `--group app,store` runs only some; an unknown group name is an error.

What a group inherits: maps (`formality`, `glossary` per language, `termNotes`, `instructions`,
`maxLength`) are merged with the top level, lists (`doNotTranslate`, `ignoreKeys`, `exclude`)
are extended, and everything else is replaced. A group with its own `targetLanguages` or
`sourceLanguage` does not inherit `copies`, since those name locales. `stateDir`, `plugins`, `dailyTokenBudget`,
`maxTokensPerRun` and `concurrency` apply to the whole run and can only be set at the top level.

### Plugins

A plugin adds project rules without forking localewarden. It is an ES module; its default
export is a plugin object, or a function that receives the options from the config:

```js
// rules/my-plugin.mjs
export default (options) => ({
  name: 'my-rules',
  // Extra findings for one translated string. "error" blocks writing it and fails `check`;
  // "fixable" lets --fix-flagged repair it.
  checks: ({ lang, key, file, source, text }) =>
    lang === 'es' && /\bcoger\b/i.test(text)
      ? [{ check: 'regional-term', note: 'use "tomar"', fixable: true }]
      : [],
  // Extra prompt text for a batch (sent with every request of the batch).
  promptNotes: ({ lang, items }) => (lang === 'es' ? 'Use neutral Latin American Spanish.' : ''),
  // Rewrites a model answer before it is checked and written.
  postProcess: ({ lang, text }) => (lang === 'fr' ? text.replace(/ ([?!:;])/g, '\u00a0$1') : text),
  // Reorders or filters the files of a group.
  order: (files, { group }) => files,
});
```

```json
{ "plugins": ["./rules/my-plugin.mjs", { "module": "./rules/blog.mjs", "options": { "draftsFolder": "drafts" } }] }
```

All hooks are optional. The interface is marked experimental in 0.x and may change in a minor
version. A complete example is in [`examples/plugin`](examples/plugin).

### App Store and Play Store listings (fastlane)

```json
{
  "sourceLanguage": "en-US",
  "targetLanguages": ["de-DE", "fr-FR", "ja"],
  "files": "fastlane/metadata/{lang}/*.txt",
  "exclude": ["fastlane/metadata/{lang}/*_url.txt"],
  "maxLength": { "name": 30, "subtitle": 30, "keywords": 100, "promotional_text": 170, "description": 4000 },
  "termNotes": { "keywords": "a comma-separated keyword list for store search, not a sentence" }
}
```

Each `.txt` file is one string, keyed by its file name, so the limits above apply to `name.txt`, `subtitle.txt` and so on.

### Flutter (ARB)

```json
{ "files": "lib/l10n/app_{lang}.arb", "targetLanguages": ["de", "fr", "pt_BR"] }
```

Metadata (`@@locale`, `@key` descriptions and placeholders) is copied, not translated, and `@@locale` is set to the target language. ICU plurals and selects keep their structure, and each language gets the plural categories it needs.

### Data files

For content JSON with ids, types and links, list the non-text keys:

```json
{ "files": "content/**/*.{lang}.json", "ignoreKeys": ["id", "type", "category", "image", "**.sources.*"] }
```

### Other providers

```json
{ "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY", "model": "anthropic/claude-sonnet-4.5" }
```

```json
{ "baseUrl": "http://localhost:11434/v1", "model": "qwen3:14b" }
```

Small local models make noticeably more mistakes. The checks catch the mechanical ones, not wrong meaning.

## Commands

```text
localewarden [translate]  --dry-run --lang de,fr --group app --fix-flagged --retranslate-all
                          --retranslate-files <patterns> --refresh-before <YYYY-MM-DD>
                          --overwrite-manual --max-tokens <n> --verbose
localewarden check        --lang de,fr --group app --verbose --limit <n> --strict --json --fix
localewarden review       --all --approve <sel>... --release <sel>...
localewarden ui           --port <n>
localewarden init
Global: --config <path>  --help  --version
```

Exit codes: `0` ok, `1` errors (or check findings), `2` configuration problem.

## Programmatic use

```ts
import { loadConfig, run, checkProject } from 'localewarden';

const config = loadConfig('localewarden.config.json');
const summary = await run(config, { languages: ['de'] });
const findings = checkProject(config);
```

`run` also accepts a `model` with a `complete(system, user)` method, so you can plug in any SDK.

## Costs and privacy

- You pay your API provider. Run `--dry-run` first: it prints the number of strings and a rough token estimate. Reasoning models also bill reasoning tokens, which can triple the cost.
- Unchanged strings cost nothing. In the example above, changing two English strings and updating four languages took 4 requests and about 4,000 tokens.
- Strings, keys, your `context` and glossary are sent to the API you configure. Nothing else is sent anywhere. There is no telemetry.

## Security

Translations are treated as untrusted: any markup the source does not have is blocked, files are only written inside the project, and API errors are redacted before printing. Details and how to report a problem: [SECURITY.md](SECURITY.md).

## Limitations

- JSON (nested objects, arrays, flat keys), Flutter ARB and plain `.txt` files. YAML, PO and XLIFF are not supported yet.
- The checks catch mechanical problems, not every wrong meaning. Have a native speaker look at important screens, then approve their edits with `review`.
- Rules for form of address, gender and typography exist for the languages listed above. Other languages are translated with the general rules.
- A run that is interrupted keeps everything written so far. Unwritten strings are picked up on the next run.

## Reliability

- **One run at a time:** a lock file in the state folder stops a second run (say CI and a local run), or an approval or edit during a run, from writing the same state; a lock left by a crashed process (or committed from another machine) is taken over safely.
- **Errors stop cleanly:** when one language fails, no further language starts, and the run ends only after the running ones finished.
- **Symbolic links** to locale files are written through; the file keeps its permissions.
- **No half-written files:** locale files and state are written to a temporary file and renamed.
- **Ctrl+C or a CI timeout** saves what was translated so far.
- **File formats are kept:** indentation, key order of existing files, Windows line endings, byte order marks. A file whose content did not change is not rewritten.
- **Unicode:** text is compared NFC-normalized, so an editor that saves "é" decomposed does not look like a hand edit.
- **Clear errors** for invalid JSON, a corrupt state file, an unknown group, an old Node.js version, or a dotted key that collides with a nested one.
- **Symbolic links** to locale folders are followed (once, so a link loop does no harm).

## Contributing

Bug reports with a concrete example (source, language, output, expected) help most. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
