# Example: a project plugin

`rules/plantly.mjs` uses every plugin hook once: a check that blocks a competitor name, a
check for a regional Spanish word, a prompt note for neutral Spanish, French typography as
post-processing, and a file order.

```bash
cd examples/plugin
export OPENAI_API_KEY=sk-...
npx localewarden --dry-run
npx localewarden
npx localewarden check -v     # plugin checks show up as their own columns
```
