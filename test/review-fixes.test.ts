import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { acquireLock, LockError } from '../src/lock.js';
import { cleanOutput, parseArray, splitLongText } from '../src/output.js';
import { checkProject } from '../src/project.js';
import { updateReview } from '../src/review.js';
import { parseReviewId } from '../src/state.js';
import { run } from '../src/translate.js';
import { editString, status } from '../src/ui/data.js';
import { PluginHost } from '../src/plugins.js';
import { fakeModel, readJson, silent, tempProject, writeJson } from './helpers.js';

describe('fixes from the 0.3.0 review', () => {
  it('stops starting languages after an error and releases the lock only when all are done', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' } }, { targetLanguages: ['de', 'fr', 'es', 'it'], concurrency: 2 });
    const plugin = { name: 'broken', promptNotes: ({ lang }: { lang: string }) => { if (lang === 'de') throw new Error('boom'); return ''; } };
    await expect(run(config, { model: fakeModel().model, logger: silent, plugins: [plugin] })).rejects.toThrow(/boom/);
    await new Promise(r => setTimeout(r, 50));
    expect(fs.existsSync(path.join(config.root, 'locales/es.json'))).toBe(false);
    expect(fs.existsSync(path.join(config.root, 'locales/it.json'))).toBe(false);
    expect(fs.existsSync(path.join(config.root, '.localewarden/run.lock'))).toBe(false);
  });

  it('does not take a translation that failed to be written for a hand edit', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello world' } });
    await run(config, { model: fakeModel().model, logger: silent });
    writeJson(config, 'locales/en.json', { a: 'Hello wide world' });
    const dir = path.join(config.root, 'locales');
    fs.chmodSync(dir, 0o555);
    try {
      await expect(run(config, { model: fakeModel().model, logger: silent })).rejects.toThrow();
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    const summary = await run(config, { model: fakeModel().model, logger: silent });
    expect(summary.languages.de.protected).toBe(0);
    expect(summary.languages.de.revised).toBe(1);
    expect(readJson(config, 'locales/de.json').a).toBe('[de] Hello wide world');
  });

  it('refuses review changes while a run holds the lock', () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' } });
    const release = acquireLock(path.join(config.root, '.localewarden'));
    try {
      expect(() => updateReview(config, 'approve', ['all'])).toThrow(LockError);
      expect(() => acquireLock(path.join(config.root, '.localewarden'))).toThrow(LockError);
    } finally {
      release();
    }
    expect(() => updateReview(config, 'approve', ['all'])).not.toThrow();
  });

  it('writes through a symbolic link to a locale file', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' }, 'shared/de.json': '{}\n' });
    fs.symlinkSync(path.join(config.root, 'shared/de.json'), path.join(config.root, 'locales/de.json'));
    await run(config, { model: fakeModel().model, logger: silent });
    expect(fs.lstatSync(path.join(config.root, 'locales/de.json')).isSymbolicLink()).toBe(true);
    expect(readJson(config, 'shared/de.json').a).toBe('[de] Hello there');
  });

  it('fills array items from the source when the interface edits one', () => {
    const config = tempProject({ 'locales/en.json': { steps: ['One', 'Two', 'Three'] } });
    editString(config, new PluginHost(), { lang: 'de', file: 'locales/{lang}.json', key: 'steps.2', value: 'Drei' });
    expect(readJson(config, 'locales/de.json')).toEqual({ steps: ['One', 'Two', 'Drei'] });
  });

  it('rejects unknown groups and languages in check', () => {
    const config = tempProject({ 'a/en.json': { a: 'Hello there' } }, { files: undefined, groups: [{ name: 'app', files: 'a/{lang}.json' }] });
    expect(() => checkProject(config, { groups: ['ap'] })).toThrow(/Unknown group/);
    expect(() => checkProject(config, { languages: ['xx'] })).toThrow(/targetLanguages/);
  });

  it('keeps a source that itself starts with "Translation:"', () => {
    expect(cleanOutput('Translation: on', 'Translation: an')).toBe('Translation: an');
    expect(cleanOutput('Save', 'Translation:\nSpeichern')).toBe('Speichern');
    expect(cleanOutput('Save', 'Translation: Speichern')).toBe('Translation: Speichern');
  });

  it('shows no token usage from yesterday', () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' }, '.localewarden/usage.json': JSON.stringify({ date: '2000-01-01', tokens: 999, requests: 9 }) });
    expect((status(config, new PluginHost()).usage as { tokens: number }).tokens).toBe(0);
  });
});

describe('hardening from the review', () => {
  it('turns null array elements into missing translations', () => {
    expect(parseArray('["a", null, 3]', 3)).toEqual(['a', null, '3']);
  });

  it('splits a single long paragraph at line breaks', () => {
    const { parts } = splitLongText('aaaa\nbbbb\ncccc', 9);
    expect(parts).toEqual(['aaaa\nbbbb', 'cccc']);
  });

  it('reads review ids whose key contains #', () => {
    expect(parseReviewId('de|locales/{lang}.json#faq.#1')).toEqual({ lang: 'de', file: 'locales/{lang}.json', key: 'faq.#1' });
  });

  it('merges group settings with the top level', () => {
    const config = resolveConfig(
      {
        targetLanguages: ['de', 'fr'],
        copies: { 'de-AT': 'de' },
        doNotTranslate: ['Acme'],
        glossary: { de: { 'Sign in': 'Anmelden' } },
        groups: [
          { name: 'app', files: 'a/{lang}.json', doNotTranslate: ['Widget'], glossary: { de: { Cart: 'Warenkorb' } } },
          { name: 'store', files: 's/{lang}/*.txt', sourceLanguage: 'en-US', targetLanguages: ['de-DE'] },
        ],
      },
      '/tmp'
    );
    const [app, store] = config.groups!;
    expect(app.doNotTranslate).toEqual(['Acme', 'Widget']);
    expect(app.glossary.de).toEqual({ 'Sign in': 'Anmelden', Cart: 'Warenkorb' });
    expect(app.copies).toEqual({ 'de-AT': 'de' });
    expect(store.copies).toEqual({});
  });

  it('a copy runs only for the selected languages', async () => {
    const config = tempProject(
      { 'store/en-US/description.txt': 'Water reminders.\n' },
      { files: 'store/{lang}/*.txt', sourceLanguage: 'en-US', targetLanguages: ['fr-FR', 'de-DE'], copies: { 'en-GB': 'en-US', 'fr-CA': 'fr-FR' } }
    );
    const summary = await run(config, { model: fakeModel().model, logger: silent, languages: ['de-DE'] });
    expect(summary.filesCopied).toEqual([]);
  });
});
