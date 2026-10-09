# Changelog

## 0.1.0

First release.

- Incremental translation of JSON locale files (new, changed and removed strings) with any OpenAI-compatible API.
- Revision mode: changed source strings are revised from the existing translation instead of re-translated.
- Hand-edit protection with a review list (`localewarden review`).
- Output checks before writing; `localewarden check` for CI; `--fix-flagged` targeted repair.
- Per-language rules for form of address, sentence case, gender-neutral address and typography.
- Glossary, protected names, term notes, per-language instructions.
- Token budget per run and dry run with a cost estimate.
