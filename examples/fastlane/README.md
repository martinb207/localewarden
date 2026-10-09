# Example: fastlane

App Store / Play Store texts in fastlane's folder layout. Each `.txt` file is one string; `maxLength` keeps the name, subtitle and keywords within the store limits, and the support URL is copied, not translated.

```bash
cd examples/fastlane
export OPENAI_API_KEY=sk-...
npx localewarden --dry-run
npx localewarden
```
