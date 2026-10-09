# localewarden

**Incremental AI translation for JSON locale files.** It translates only what changed, never overwrites a translation a person fixed, and checks every result before it is written.

```bash
npx localewarden init        # create a config
npx localewarden --dry-run   # see what would be translated and roughly what it costs
npx localewarden             # translate new and changed strings
npx localewarden check       # quality check, no API calls (use it in CI)
```

Works with i18next, react-intl / FormatJS, vue-i18n, next-intl, ngx-translate and any other setup that keeps strings in JSON files. Uses any OpenAI-compatible API (OpenAI, OpenRouter, a local Ollama, ...).

## Why

Translating locale files with a language model is easy once. Keeping 20 languages correct while the source keeps changing is not:

- **Re-translating everything** on every change costs money and rewrites wording that was already fine.
- **Hand fixes get overwritten** by the next run.
- **Models are inconsistent across batches.** French screens mix "tu" and "vous", Spanish copies English Title Case ("Configure Su Cuenta"), and Polish or Russian address every user as a man.
- **Broken output ships silently.** A translated placeholder (`{heures}` instead of `{hours}`) shows raw braces in your app. A dropped `</strong>` breaks the layout. Stray Cyrillic letters end up in a Danish sentence.

localewarden grew out of the translation pipeline of a production app that ships in 38 languages. Every rule and check in it exists because one of these failures happened in real output.

## What it does

- **Translates only what changed.** It remembers a hash of each source string per language. New strings are translated. Changed strings are *revised*: the model gets the existing translation and changes only what the source change requires. Removed strings are deleted from every language.
- **Protects hand edits.** If someone edited a translation, localewarden detects it, keeps it, and lists it for review. If the source of a hand-edited string changes later, the string is flagged instead of overwritten.
- **Checks every result before writing it.** Broken placeholders, foreign alphabets, changed links, broken HTML and echoed source text are rejected (retried once, then left for the next run). Softer problems are retried and reported.
- **Consistent style per language.** It enforces formal or informal address per language (`du`/`Sie`, `tu`/`vous`, `ты`/`вы` and 16 more), uses sentence case where the language does, avoids gendered forms for "you", and applies local typography (French spacing, `92 %` in German, CJK quotation marks).
- **Glossary and protected names.** You choose fixed renderings ("Privacy Policy" -> "Politique de confidentialité") and names that must never be translated. The check accepts grammatical case endings.
- **Quality check for CI.** `localewarden check` runs all checks without any API calls and exits non-zero on errors.
- **Targeted repair.** `--fix-flagged` asks the model to fix only what the check flagged. The fix is accepted only if the problem is gone and little else changed.
- **Budget control.** A token budget per run, a dry run with a cost estimate, and graceful stop and resume.
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

German uses "du" and French "vous", as configured. Spanish and French use sentence case, not the English Title Case. French has its space before "!". The hedge "tend to" survived, and so did the placeholders, the link and the brand name. The full example is in [`examples/basic`](examples/basic).

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

   `.localewarden/` holds the hashes that tell localewarden what changed and what was edited by hand. Commit it so your team and your CI share the same state.

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
| `script` | Letters from an alphabet the language does not use ("刺激" in German), or a word that mixes Latin with Cyrillic/Greek lookalikes ("Вarda") | error |
| `markup` | Changed link targets, different number of tags, unclosed or misnested tags, dropped list items | warning (broken tags and changed links: never written) |
| `years` | A year from the source missing or changed (citations, dates) | warning |
| `formality` | The other form of address than configured, both forms in one string, or masculine-only forms for "you" | warning |
| `titlecase` | English Title Case copied into a language that uses sentence case | warning |
| `ampersand` | "&" in languages that write the word | warning |
| `glossary` | A glossary rendering missing (case endings allowed), or a `doNotTranslate` name translated | warning |
| `untranslated` | Identical to the source (prose of 3+ words; "OK" and names are fine) | warning |
| `partial` | Source-language words left inside the translation, an untranslated bold lead-in, or a hedge that became certainty ("tend to" stated as fact) | warning |

```bash
npx localewarden check              # counts per language and check
npx localewarden check -v           # with examples
npx localewarden check --strict     # exit 1 on warnings too
npx localewarden check --json       # for scripts
```

Approved hand edits are skipped, except for placeholder and script errors, which break the app either way.

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

### Fixing what the check finds

```bash
npx localewarden --fix-flagged
```

For each flagged string, the model gets the source, the current translation and the exact findings, with the instruction to change only what is needed. The fix is written only if the same check passes afterwards, nothing else breaks, and few words changed. Rejected fixes are recorded in `.localewarden/repair-failures.json` and not retried until the translation changes.

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
localewarden [translate]  --dry-run --lang de,fr --fix-flagged --retranslate-all
                          --overwrite-manual --max-tokens <n> --verbose
localewarden check        --lang de,fr --verbose --limit <n> --strict --json
localewarden review       --all --approve <sel>... --release <sel>...
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

## Limitations

- JSON only (nested objects, arrays, flat keys). YAML, PO, XLIFF and ARB are not supported yet.
- The checks catch mechanical problems, not every wrong meaning. Have a native speaker look at important screens, then approve their edits with `review`.
- Rules for form of address, gender and typography exist for the languages listed above. Other languages are translated with the general rules.
- A run that is interrupted keeps everything written so far. Unwritten strings are picked up on the next run.

## License

[MIT](LICENSE)
