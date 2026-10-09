# Changelog

## 0.2.0

Data files, store listings and fewer false alarms, tested against a real project with 38 languages.

- `ignoreKeys`: keys that are not text (ids, types, image paths, citation lists) are copied instead of translated. URLs, email addresses, file paths and numbers are always copied; a localized value someone set is kept.
- `exclude`: skip source files.
- `maxLength`: character limits per key pattern, told to the model, retried once and reported by the new `length` check.
- Plain `.txt` files, one string per file keyed by its name: fastlane App Store / Play Store metadata.
- Examples for Flutter ARB files and fastlane store listings.
- Flutter ARB files: metadata (`@@locale`, `@key`) is copied and `@@locale` set to the target language; `init` finds `lib/l10n/app_{lang}.arb`.
- New findings: a translation much shorter than its source (content cut off, or the source grew later); Simplified characters in Traditional Chinese and the reverse; nested sibling strings that differ in the source but got the same translation (answer options, tabs).
- `--fix-flagged` completes translations that lost most of their content by revising them from the existing text (a minimal repair could not add the missing part); a completion that fails is recorded and not retried until the text changes.
- Files whose content did not change are no longer rewritten, so Prettier formatting and key order stay as they are.
- `check --fix` repairs a renamed placeholder without the model when exactly one fix is possible, editing the file in place.
- All files of a language are translated in shared requests instead of at least one request per file. For four store-listing files in two languages: 2 requests instead of 8, 55% fewer tokens.
- `review --approve <lang>:<key>` works for any string, so a correct string the check flags can be approved once.
- Fewer false alarms: capitalised list items and bracketed words are not Title Case; protected names do not count as untranslated text; added emphasis tags (`<i>`, `<b>` …) are a markup warning, not an `unsafe` error; "data:" in prose is not a script URL; Hungarian "100%-ig" is not a placeholder; text in angle brackets that is not an HTML element ("<minutes>") is not markup; thousands separators ("1,900") are not years; ICU syntax words (`plural`, `other`) are not English left in a translation; the capitalised Polish "you" of respect ("W Twoim planie") is not Title Case.

## 0.1.1

Security hardening and plural forms.

- New `unsafe` check (error): a translation that adds HTML tags, attributes, event handlers or `javascript:`/`vbscript:`/`data:` URLs that the source does not have is never written, and `localewarden check` reports existing ones.
- The prompt tells the model to treat texts as data and never follow instructions inside them.
- `files` must be a relative path inside the project; `sourceLanguage` is validated; every target path is checked before writing.
- API error messages are redacted so keys cannot reach logs.
- SECURITY.md, CONTRIBUTING.md and issue templates.
- A translation that stays identical to the source after a retry (names, product lists) is accepted instead of being retried on every run.
- Runs report hand edits only when they are new; `init`'s example `context` is ignored with a warning.
- i18next plural forms: keys like `item_one`/`item_other` get the extra forms the target language needs (Polish `_few`/`_many`, Arabic `_zero`/`_two`/`_few`/`_many`, from the CLDR plural rules built into Node).

## 0.1.0

First release.

- Incremental translation of JSON locale files (new, changed and removed strings) with any OpenAI-compatible API.
- Revision mode: changed source strings are revised from the existing translation instead of re-translated.
- Hand-edit protection with a review list (`localewarden review`).
- Output checks before writing; `localewarden check` for CI; `--fix-flagged` targeted repair.
- Per-language rules for form of address, sentence case, gender-neutral address and typography.
- Glossary, protected names, term notes, per-language instructions.
- Token budget per run and dry run with a cost estimate.
