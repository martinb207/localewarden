# Changelog

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
