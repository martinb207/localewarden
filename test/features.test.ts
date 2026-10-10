import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Budget, BudgetExceededError } from '../src/budget.js';
import { resolveConfig } from '../src/config.js';
import { cleanOutput, splitLongText } from '../src/output.js';
import { checkProject } from '../src/project.js';
import { State } from '../src/state.js';
import { run } from '../src/translate.js';
import { fakeModel, readJson, silent, tempProject, writeJson } from './helpers.js';

const PLUGIN = `
export default (options) => ({
  name: 'test-rules',
  checks: ({ text }) => [
    ...(text.includes('FORBIDDEN') ? [{ check: 'forbidden-word', severity: 'error', note: 'contains FORBIDDEN' }] : []),
    ...(text.includes('meh') ? [{ check: 'tone', note: 'too casual', fixable: true }] : []),
  ],
  promptNotes: ({ items }) => items.some(i => i.source.toLowerCase().includes('snooze')) ? 'NOTE-FROM-PLUGIN: snooze means postpone.' : '',
  postProcess: ({ text }) => text.replace(/ %/g, '\\u00a0%'),
  order: (files) => files.filter(f => !f.id.includes(options?.skip ?? '---')),
});
`;

describe('plugins', () => {
  const project = (extra: Record<string, unknown> = {}) =>
    tempProject(
      {
        'locales/en/a.json': { s: 'Snooze the reminder', p: 'Up to 50 % off' },
        'locales/en/draft.json': { d: 'Not ready yet' },
        'rules.mjs': PLUGIN,
      },
      { files: 'locales/{lang}/*.json', plugins: [{ module: './rules.mjs', options: { skip: 'draft' } }], ...extra }
    );

  it('adds prompt notes, post-processes answers and filters files', async () => {
    const config = project();
    const { model, calls } = fakeModel();
    await run(config, { model, logger: silent });
    expect(calls[0].system).toContain('NOTE-FROM-PLUGIN');
    expect(readJson(config, 'locales/de/a.json').p).toBe('[de] Up to 50 % off');
    expect(fs.existsSync(path.join(config.root, 'locales/de/draft.json'))).toBe(false);
  });

  it('blocks translations with a plugin error and reports plugin checks', async () => {
    const config = project();
    const { model } = fakeModel(text => (text.includes('Snooze') ? `${text} FORBIDDEN` : text));
    const summary = await run(config, { model, logger: silent });
    expect(summary.languages.de.failed).toBe(1);
    expect(readJson(config, 'locales/de/a.json').s).toBeUndefined();

    writeJson(config, 'locales/de/a.json', { s: 'Erinnerung verschieben meh', p: 'Bis zu 50 % Rabatt' });
    const { loadPlugins } = await import('../src/plugins.js');
    const findings = checkProject(config, { plugins: await loadPlugins(config) });
    expect(findings.find(f => f.check === 'tone')).toMatchObject({ severity: 'warning', key: 's' });
  });

  it('lets --fix-flagged repair fixable plugin findings', async () => {
    const config = project();
    await run(config, { model: fakeModel().model, logger: silent });
    writeJson(config, 'locales/de/a.json', { s: 'Erinnerung verschieben meh', p: '[de] Up to 50 % off' });
    await run(config, { model: fakeModel().model, logger: silent }); // registers the hand edit
    const { updateReview } = await import('../src/review.js');
    updateReview(config, 'release', ['de:s']);
    const { model, calls } = fakeModel(() => 'Erinnerung verschieben');
    await run(config, { model, logger: silent, fixFlagged: true });
    expect(calls.length).toBeGreaterThan(0);
  });

  it('names the plugin when it fails to load', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hi there you' } }, { plugins: ['./missing.mjs'] });
    await expect(run(config, { model: fakeModel().model, logger: silent })).rejects.toThrow(/missing\.mjs/);
  });
});

describe('groups', () => {
  it('translates groups in order with their own settings and can run one group', async () => {
    const config = tempProject(
      { 'app/en.json': { a: 'Open settings' }, 'content/en.json': { b: 'A long lesson text here' } },
      {
        files: undefined,
        groups: [
          { name: 'app', files: 'app/{lang}.json' },
          { name: 'content', files: 'content/{lang}.json', targetLanguages: ['fr'], reasoningEffort: 'low' },
        ],
      }
    );
    expect(config.groups?.map(g => g.name)).toEqual(['app', 'content']);
    expect(config.groups?.[1].reasoningEffort).toBe('low');
    const { model, calls } = fakeModel();
    await run(config, { model, logger: silent });
    expect(calls.map(c => /\((\w+)\)/.exec(c.system)?.[1])).toEqual(['de', 'fr']);
    expect(readJson(config, 'content/fr.json').b).toBe('[fr] A long lesson text here');

    writeJson(config, 'app/en.json', { a: 'Open the settings' });
    writeJson(config, 'content/en.json', { b: 'A longer lesson text here' });
    const only = fakeModel();
    await run(config, { model: only.model, logger: silent, groups: ['content'] });
    expect(only.calls).toHaveLength(1);
    expect(readJson(config, 'app/de.json').a).toBe('[de] Open settings');
  });

  it('rejects global settings inside a group and unknown group names', async () => {
    expect(() => resolveConfig({ targetLanguages: ['de'], groups: [{ name: 'x', files: 'a/{lang}.json', stateDir: 'y' }] }, '/tmp')).toThrow(/top level/);
    expect(() => resolveConfig({ targetLanguages: ['de'], groups: [{ name: 'x', files: 'a/{lang}.json' }, { name: 'x', files: 'b/{lang}.json' }] }, '/tmp')).toThrow(/twice/);
    const config = tempProject({ 'a/en.json': { a: 'Hello there' } }, { files: undefined, groups: [{ name: 'x', files: 'a/{lang}.json' }] });
    await expect(run(config, { model: fakeModel().model, logger: silent, groups: ['nope'] })).rejects.toThrow(/Unknown group/);
  });
});

describe('budget', () => {
  it('stops at the daily budget across runs and keeps usage per UTC day', async () => {
    // Each single request costs 50 tokens in the fake model: the third one is not sent.
    const config = tempProject({ 'locales/en.json': { a: 'Hello there', b: 'Good night', c: 'See you soon' } }, { dailyTokenBudget: 60, batchSize: 1, concurrency: 1 });
    const first = await run(config, { model: fakeModel().model, logger: silent });
    expect(first.stoppedByBudget).toBe(true);
    expect(first.stopReason).toMatch(/daily/);
    const usage = JSON.parse(fs.readFileSync(path.join(config.root, '.localewarden/usage.json'), 'utf8'));
    expect(usage.tokens).toBe(100);
    expect(readJson(config, 'locales/de.json').c).toBeUndefined();
    const { model, calls } = fakeModel();
    const second = await run(config, { model, logger: silent });
    expect(calls).toHaveLength(0);
    expect(second.stoppedByBudget).toBe(true);
  });

  it('throws once the run budget is used', () => {
    const budget = new Budget(10);
    budget.record(10);
    expect(() => budget.check()).toThrow(BudgetExceededError);
  });
});

describe('copies', () => {
  it('writes regional copies after translating', async () => {
    const config = tempProject(
      { 'store/en-US/description.txt': 'Water reminders for your plants.\n' },
      { files: 'store/{lang}/*.txt', sourceLanguage: 'en-US', targetLanguages: ['fr-FR'], copies: { 'en-GB': 'en-US', 'fr-CA': 'fr-FR' } }
    );
    const summary = await run(config, { model: fakeModel().model, logger: silent });
    const read = (p: string) => fs.readFileSync(path.join(config.root, p), 'utf8');
    expect(read('store/en-GB/description.txt')).toBe('Water reminders for your plants.\n');
    expect(read('store/fr-CA/description.txt')).toBe(read('store/fr-FR/description.txt'));
    expect(summary.filesCopied.sort()).toEqual(['store/en-GB/description.txt', 'store/fr-CA/description.txt']);
    expect(() => resolveConfig({ files: 'x/{lang}.json', targetLanguages: ['de'], copies: { 'de-AT': 'fr' } }, '/tmp')).toThrow(/copies/);
  });
});

describe('long texts and model output', () => {
  it('translates very long new strings paragraph by paragraph', async () => {
    const paragraph = 'This paragraph explains one idea in a few calm sentences. '.repeat(4).trim();
    const long = Array.from({ length: 6 }, () => paragraph).join('\n\n');
    const config = tempProject({ 'locales/en.json': { a: long } }, { chunkChars: 600 });
    const { model, calls } = fakeModel();
    await run(config, { model, logger: silent });
    expect(calls.length).toBeGreaterThan(1);
    expect(readJson(config, 'locales/de.json').a.split('\n\n')).toHaveLength(6);
  });

  it('splits at paragraph breaks and keeps the separators', () => {
    const { parts, separators } = splitLongText('aaa\n\nbbb\n\nccc', 7);
    expect(parts).toEqual(['aaa', 'bbb', 'ccc']);
    expect(parts.map((p, i) => p + (separators[i] ?? '')).join('')).toBe('aaa\n\nbbb\n\nccc');
  });

  it('strips commentary, code fences and wrapping quotes', () => {
    expect(cleanOutput('Save', "Here's the translation:\nSpeichern")).toBe('Speichern');
    expect(cleanOutput('Save', '```\nSpeichern\n```')).toBe('Speichern');
    expect(cleanOutput('Save', '"Speichern"')).toBe('Speichern');
    expect(cleanOutput('"Save"', '„Speichern“')).toBe('„Speichern“');
  });
});

describe('refresh and retranslate options', () => {
  it('re-translates strings written before a date and files on request', async () => {
    const config = tempProject(
      { 'locales/en/a.json': { x: 'First text here' }, 'locales/en/b.json': { y: 'Second text here' }, 'locales/de/a.json': { x: 'Erster Text' } },
      { files: 'locales/{lang}/*.json' }
    );
    await run(config, { model: fakeModel().model, logger: silent });
    const state = new State(path.join(config.root, '.localewarden'));
    expect(state.get('de', 'locales/{lang}/a.json', 'x')?.date).toBe(''); // adopted
    expect(state.get('de', 'locales/{lang}/b.json', 'y')?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const refresh = fakeModel();
    await run(config, { model: refresh.model, logger: silent, refreshBefore: '2000-01-01' });
    expect(refresh.calls).toHaveLength(1); // only the adopted string
    expect(readJson(config, 'locales/de/a.json').x).toBe('[de] First text here');

    const files = fakeModel();
    await run(config, { model: files.model, logger: silent, retranslateFiles: ['locales/{lang}/b.json'] });
    expect(files.calls).toHaveLength(1);
    expect(files.calls[0].user).toBe('Second text here');
  });
});
