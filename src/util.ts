import { createHash } from 'node:crypto';

/** Short content hash. NFC-normalized, so an editor that stores "é" decomposed is no edit. */
export const hash = (value: string): string =>
  createHash('sha256').update(value.normalize('NFC').trim()).digest('hex').slice(0, 12);

export const today = (): string => new Date().toISOString().slice(0, 10);

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Base language of a code: "pt-BR" -> "pt", "zh-Hant" -> "zh". */
export const baseLanguage = (lang: string): string => lang.split(/[-_]/)[0].toLowerCase();

/** Traditional Chinese, which uses different quotation marks and wording than Simplified. */
export const isTraditionalChinese = (lang: string): boolean =>
  /^zh[-_](tw|hk|mo|hant)/i.test(lang);

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** English name of a language code ("de" -> "German", "pt-BR" -> "Brazilian Portuguese"). */
export function languageName(lang: string): string {
  try {
    return displayNames.of(lang.replace('_', '-')) ?? lang;
  } catch {
    return lang;
  }
}

export function sortObject<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight. After the first error no
 * new item starts, and the error is thrown only once every running worker has finished, so
 * nothing keeps writing after the caller has cleaned up (released its lock).
 */
export async function inParallel<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const run = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
  if (failure) throw (failure as { error: unknown }).error;
}
