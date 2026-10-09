import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run, tooManyChanges } from '../src/translate.js';
import { listReview, updateReview } from '../src/review.js';
import { fakeModel, readJson, silent, tempProject, writeJson } from './helpers.js';

describe('run', () => {
  it('translates missing strings and keeps the source structure and key order', async () => {
    const config = tempProject({
      'locales/en.json': { title: 'Welcome back', nested: { save: 'Save changes', count: 3 }, list: ['First step', 'Second step'] },
    });
    const { model } = fakeModel();
    const summary = await run(config, { model, logger: silent });
    expect(readJson(config, 'locales/de.json')).toEqual({
      title: '[de] Welcome back',
      nested: { save: '[de] Save changes', count: 3 },
      list: ['[de] First step', '[de] Second step'],
    });
    expect(summary.languages.de.translated).toBe(4);
    expect(fs.existsSync(path.join(config.root, '.localewarden/state.json'))).toBe(true);
  });

  it('makes no API calls when nothing changed', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' } });
    await run(config, { model: fakeModel().model, logger: silent });
    const { model, calls } = fakeModel();
    await run(config, { model, logger: silent });
    expect(calls).toHaveLength(0);
  });

  it('adopts existing translations on the first run instead of re-translating them', async () => {
    const config = tempProject({
      'locales/en.json': { a: 'Hello there', b: 'Good night' },
      'locales/de.json': { a: 'Hallo zusammen' },
    });
    const { model, calls } = fakeModel();
    await run(config, { model, logger: silent });
    expect(readJson(config, 'locales/de.json')).toEqual({ a: 'Hallo zusammen', b: '[de] Good night' });
    expect(calls).toHaveLength(1);
  });

  it('revises a string whose source changed and passes the previous translation', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Save your work' } });
    await run(config, { model: fakeModel().model, logger: silent });
    writeJson(config, 'locales/en.json', { a: 'Save your work now' });
    const { model, calls } = fakeModel();
    const summary = await run(config, { model, logger: silent });
    expect(summary.languages.de.revised).toBe(1);
    expect(calls[0].system).toContain('REVISION');
    expect(calls[0].system).toContain('[de] Save your work');
  });

  it('protects hand edits and lists them for review', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Save your work' } });
    await run(config, { model: fakeModel().model, logger: silent });
    writeJson(config, 'locales/de.json', { a: 'Speichere deine Arbeit' });
    writeJson(config, 'locales/en.json', { a: 'Save all your work' });
    const { model, calls } = fakeModel();
    const summary = await run(config, { model, logger: silent });
    expect(calls).toHaveLength(0);
    expect(readJson(config, 'locales/de.json').a).toBe('Speichere deine Arbeit');
    expect(summary.pendingReview).toBe(1);
    expect(listReview(config)[0]).toMatchObject({ lang: 'de', key: 'a', reason: 'source-changed' });
  });

  it('re-translates a released hand edit on the next run', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Save your work' } });
    await run(config, { model: fakeModel().model, logger: silent });
    writeJson(config, 'locales/de.json', { a: 'Speichere deine Arbeit' });
    await run(config, { model: fakeModel().model, logger: silent });
    expect(updateReview(config, 'release', ['de:a'])).toBe(1);
    const { model, calls } = fakeModel();
    await run(config, { model, logger: silent });
    expect(calls).toHaveLength(1);
    expect(readJson(config, 'locales/de.json').a).toBe('[de] Save your work');
  });

  it('keeps approved hand edits protected', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Save your work' } });
    await run(config, { model: fakeModel().model, logger: silent });
    writeJson(config, 'locales/de.json', { a: 'Speichere deine Arbeit' });
    await run(config, { model: fakeModel().model, logger: silent });
    updateReview(config, 'approve', ['all']);
    const { model, calls } = fakeModel();
    const summary = await run(config, { model, logger: silent, retranslateAll: true });
    expect(calls).toHaveLength(0);
    expect(summary.pendingReview).toBe(0);
  });

  it('never writes a translation with a broken placeholder', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'You have {count} new messages' } });
    const { model } = fakeModel(text => text.replace('{count}', '{anzahl}'));
    const summary = await run(config, { model, logger: silent });
    expect(summary.languages.de.failed).toBe(1);
    expect(fs.existsSync(path.join(config.root, 'locales/de.json'))).toBe(false);
  });

  it('retries a defective batch element on its own and keeps the clean version', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Open {file} now', b: 'Close the window' } });
    const { model, calls } = fakeModel((text, system) => (system.includes('JSON array') ? text.replace('{file}', '{datei}') : text));
    await run(config, { model, logger: silent });
    expect(calls.map(c => (c.system.includes('JSON array') ? 'batch' : 'single'))).toEqual(['batch', 'single']);
    expect(readJson(config, 'locales/de.json').a).toBe('[de] Open {file} now');
  });

  it('removes strings that were deleted from the source', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there', b: 'Old string' } });
    await run(config, { model: fakeModel().model, logger: silent });
    writeJson(config, 'locales/en.json', { a: 'Hello there' });
    const summary = await run(config, { model: fakeModel().model, logger: silent });
    expect(readJson(config, 'locales/de.json')).toEqual({ a: '[de] Hello there' });
    expect(summary.languages.de.removed).toBe(1);
  });

  it('dry run makes no calls and writes nothing', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' } });
    const { model, calls } = fakeModel();
    const summary = await run(config, { model, logger: silent, dryRun: true });
    expect(calls).toHaveLength(0);
    expect(summary.languages.de.planned).toBe(1);
    expect(fs.existsSync(path.join(config.root, 'locales/de.json'))).toBe(false);
    expect(fs.existsSync(path.join(config.root, '.localewarden'))).toBe(false);
  });

  it('stops at the token budget and continues on the next run', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' } }, { targetLanguages: ['de', 'fr'], concurrency: 1 });
    const first = await run(config, { model: fakeModel().model, logger: silent, maxTokens: 50 });
    expect(first.stoppedByBudget).toBe(true);
    const { model, calls } = fakeModel();
    await run(config, { model, logger: silent });
    expect(calls).toHaveLength(1);
    expect(readJson(config, 'locales/fr.json').a).toBe('[fr] Hello there');
  });

  it('does not overwrite a target file that is not valid JSON', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' }, 'locales/de.json': '{ broken' });
    await run(config, { model: fakeModel().model, logger: silent });
    expect(fs.readFileSync(path.join(config.root, 'locales/de.json'), 'utf8')).toBe('{ broken');
  });

  it('works with one folder per language and several files', async () => {
    const config = tempProject(
      { 'locales/en/common.json': { a: 'Hello there' }, 'locales/en/settings.json': { b: 'Dark mode' } },
      { files: 'locales/{lang}/*.json' }
    );
    await run(config, { model: fakeModel().model, logger: silent });
    expect(readJson(config, 'locales/de/common.json')).toEqual({ a: '[de] Hello there' });
    expect(readJson(config, 'locales/de/settings.json')).toEqual({ b: '[de] Dark mode' });
  });

  it('repairs flagged strings with --fix-flagged and rejects rewrites', async () => {
    const config = tempProject(
      { 'locales/en.json': { a: 'Set Up Your Account' }, 'locales/fr.json': { a: 'Configurez Votre Compte' } },
      { targetLanguages: ['fr'] }
    );
    await run(config, { model: fakeModel().model, logger: silent });
    const { model } = fakeModel(() => 'Configurez votre compte');
    const summary = await run(config, { model, logger: silent, fixFlagged: true });
    expect(summary.languages.fr.repaired).toBe(1);
    expect(readJson(config, 'locales/fr.json').a).toBe('Configurez votre compte');
  });

  it('limits how much a targeted repair may change', () => {
    expect(tooManyChanges('one two three four five six seven eight', 'one two three four five six seven nine')).toBeNull();
    expect(tooManyChanges('a b c d e f g h', 'z y x w v u t s')).toMatch(/changed 8 words/);
  });
});
