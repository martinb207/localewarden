# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately via
[GitHub private vulnerability reporting](https://github.com/martinb207/localewarden/security/advisories/new).

Include what you found, how to reproduce it, and which version you used. I will confirm
receipt within a few days. This is a one-person project, so fixes may take a little longer,
but security reports are handled before anything else.

## Supported versions

Only the latest release receives fixes.

## What localewarden does to stay safe

- **Translated text is untrusted.** Model output often ends up rendered as HTML in apps. A
  translation that adds an HTML tag, an attribute, an event handler or a `javascript:`,
  `vbscript:` or `data:` URL that the source does not contain is never written, and
  `localewarden check` reports it as an error.
- **Source strings are data, not instructions.** The prompt tells the model not to follow
  instructions inside the texts. The output checks above catch what gets through anyway.
- **Files stay inside the project.** The `files` pattern must be a relative path without
  `..`, language codes are validated, and every target path is verified to be inside the
  project before writing.
- **API keys.** The key is read from an environment variable and sent only to the configured
  `baseUrl`. Error messages from the API are redacted before they are printed.
- **No runtime dependencies,** so installing localewarden pulls in no third-party code.

## What it does not protect against

- A wrong meaning in a translation. The checks catch mechanical problems, not every mistake.
- Markup that is already in your source strings. If your source contains unsafe HTML, the
  translations will too. Sanitize HTML where you render it.
- A `baseUrl` you do not trust. Everything in the prompt (strings, keys, context, glossary)
  is sent there.
