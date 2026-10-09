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

## Pull requests

- Keep changes focused, and add a test for every bug fix and new check.
- New language rules (form of address, gendered forms) need examples of real model output
  they fix and should not flag correct text. Patterns that would flag common correct words
  are worse than no pattern.
- No new runtime dependencies without a strong reason.
- Run `npm run typecheck && npm test` before opening the pull request.

Security problems: see [SECURITY.md](SECURITY.md).
