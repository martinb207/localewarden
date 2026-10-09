import type { Config } from './config.js';
import { isLiteralValue, keyPattern, pathPattern, type LocaleFile } from './files.js';

/** Which files and strings localewarden translates, and their length limits. */
export class Scope {
  private readonly excluded: RegExp[];
  private readonly ignored: RegExp[];
  private readonly limits: [RegExp, number][];

  constructor(private readonly config: Config) {
    this.excluded = config.exclude.map(pathPattern);
    this.ignored = config.ignoreKeys.map(keyPattern);
    this.limits = Object.entries(config.maxLength).map(([pattern, max]) => [keyPattern(pattern), max]);
  }

  /** Excluded by id ("locales/{lang}/nav.json") or by the source path ("locales/en/nav.json"). */
  isExcluded(file: LocaleFile): boolean {
    const paths = [file.id, file.pathFor(this.config.sourceLanguage)];
    return this.excluded.some(re => paths.some(p => re.test(p)));
  }

  /** Not text: an ignored key or a URL, email, file path or number. Copied, never translated. */
  isLiteral(key: string, value: string): boolean {
    return this.ignored.some(re => re.test(key)) || isLiteralValue(value);
  }

  maxLength(key: string): number | undefined {
    return this.limits.find(([re]) => re.test(key))?.[1];
  }
}
