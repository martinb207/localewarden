# Contributing

Thanks for your interest. Issues and pull requests are welcome.

## Reporting a translation problem

The most useful report is a concrete example: the source string, the language, the
translation localewarden produced (or let through), and what it should have been. If a check
should have caught it, say which one.

## Development

```bash
git clone https://github.com/martinb207/localewarden.git
cd localewarden
npm install
npm run typecheck
npm test
npm run build
```

The tests use a fake model and need no API key. To try a real run, use the example:

```bash
npm run build
cd examples/basic
OPENAI_API_KEY=sk-... node ../../dist/cli.js --dry-run
```

## Code layout

- `src/translate.ts` runs groups and languages; the steps live in `src/engine/`:
  `planner.ts` (what to translate, revise, protect), `translator.ts` (requests, batches, long
  texts), `repair.ts` (`--fix-flagged`), `writer.ts` (writing files), `copies.ts`, `sources.ts`.
- `src/checks.ts` and `src/placeholders.ts`: quality checks; `src/style.ts`: per-language rules.
- `src/plugins.ts`, `src/budget.ts`, `src/lock.ts`, `src/state.ts`, `src/config.ts`.
- `src/ui/`: the web interface (`server.ts`, `data.ts`, `page.ts`).

## Pull requests

- Keep changes focused, and add a test for every bug fix and new check.
- New language rules (form of address, gendered forms) need examples of real model output
  they fix and should not flag correct text. Patterns that would flag common correct words
  are worse than no pattern.
- No new runtime dependencies without a strong reason.
- Run `npm run typecheck && npm test` before opening the pull request.

Security problems: see [SECURITY.md](SECURITY.md).

## Releasing (maintainer)

1. Bump `version` in `package.json` (and `package-lock.json` via `npm install --package-lock-only`) and add a `CHANGELOG.md` entry at the top.
2. Commit and push, then tag: `git tag v0.1.2 && git push origin v0.1.2`.
3. The Release workflow tests, publishes to npm via trusted publishing and creates the GitHub release.
