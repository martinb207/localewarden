import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { buildTarget, detectFormat, findSourceFiles, flatten, isLiteralValue, keyPattern, pathPattern } from '../src/files.js';
import { batchPrompt } from '../src/prompt.js';
import { tempProject } from './helpers.js';

describe('findSourceFiles', () => {
  it('matches {lang}, * and **/ and maps paths to other languages', () => {
    const config = tempProject({
      'app/en/common.json': {},
      'app/en/deep/nested.json': {},
      'app/de/common.json': {},
      'app/en/readme.md': '',
    });
    const files = findSourceFiles(config.root, 'app/{lang}/**/*.json', 'en');
    expect(files.map(f => f.id)).toEqual(['app/{lang}/common.json', 'app/{lang}/deep/nested.json']);
    expect(files[1].pathFor('fr')).toBe('app/fr/deep/nested.json');
  });

  it('supports the language in the file name', () => {
    const config = tempProject({ 'i18n/messages.en.json': {}, 'i18n/messages.de.json': {} });
    const files = findSourceFiles(config.root, 'i18n/messages.{lang}.json', 'en');
    expect(files.map(f => f.pathFor('pt-BR'))).toEqual(['i18n/messages.pt-BR.json']);
  });
});

describe('patterns', () => {
  it('matches keys by segment', () => {
    expect(keyPattern('id').test('steps.2.id')).toBe(true);
    expect(keyPattern('id').test('steps.2.hidden')).toBe(false);
    expect(keyPattern('*.meta.title').test('home.meta.title')).toBe(true);
    expect(keyPattern('*.meta.title').test('a.home.meta.title')).toBe(false);
    expect(keyPattern('**.meta.title').test('a.home.meta.title')).toBe(true);
  });

  it('matches paths', () => {
    expect(pathPattern('locales/{lang}/nav.json').test('locales/{lang}/nav.json')).toBe(true);
    expect(pathPattern('**/nav.json').test('src/locales/en/nav.json')).toBe(true);
    expect(pathPattern('locales/*/nav.json').test('locales/en/nav.json')).toBe(true);
  });

  it('recognises values that are not text', () => {
    for (const v of ['https://example.com/a?b=1', 'hello@example.com', 'images/a.png', '/img/x.svg', '42', '3:45', '+41 44 000 00 00']) {
      expect(isLiteralValue(v)).toBe(true);
    }
    for (const v of ['Hello', 'Visit https://example.com for more', 'A', 'Step 2']) {
      expect(isLiteralValue(v)).toBe(false);
    }
  });
});

describe('JSON helpers', () => {
  it('omits missing object keys and keeps array indices', () => {
    const source = { a: 'A', b: { c: 'C' }, list: ['x', 'y'], n: 1 };
    const built = buildTarget(source, new Map([['a', 'AA'], ['list.1', 'YY']]));
    expect(built).toEqual({ a: 'AA', list: ['x', 'YY'], n: 1 });
  });

  it('flattens to dotted keys', () => {
    expect([...flatten({ a: { b: 'x' }, l: ['y'] })]).toEqual([['a.b', 'x'], ['l.0', 'y']]);
  });

  it('keeps the indentation of existing files', () => {
    expect(detectFormat('{\n    "a": 1\n}\n')).toEqual({ indent: '    ', finalNewline: true, eol: '\n', bom: false });
    expect(detectFormat(null).indent).toBe('  ');
  });
});

describe('config and prompt', () => {
  it('rejects unknown options and bad patterns', () => {
    expect(() => resolveConfig({ targetLanguages: ['de'], files: 'locales/en.json' }, '/tmp')).toThrow(/\{lang\}/);
    expect(() => resolveConfig({ targetLanguages: ['de'], files: 'x/{lang}.json', colour: 1 }, '/tmp')).toThrow(/Unknown/);
    expect(() => resolveConfig({ targetLanguages: ['en'], files: 'x/{lang}.json' }, '/tmp')).toThrow(/source language/);
    expect(() => resolveConfig({ targetLanguages: ['de'], files: '../x/{lang}.json' }, '/tmp')).toThrow(/inside the project/);
    expect(() => resolveConfig({ targetLanguages: ['de'], files: '/etc/{lang}.json' }, '/tmp')).toThrow(/inside the project/);
    expect(() => resolveConfig({ targetLanguages: ['de'], files: 'x/{lang}.json', sourceLanguage: '../en' }, '/tmp')).toThrow(/sourceLanguage/);
  });

  it('builds the prompt from the config', () => {
    const config = resolveConfig(
      {
        targetLanguages: ['fr'],
        files: 'x/{lang}.json',
        context: 'A recipe app.',
        doNotTranslate: ['Acme'],
        formality: { fr: 'formal' },
        termNotes: { 'meal prep': 'cooking meals in advance' },
      },
      '/tmp'
    );
    const prompt = batchPrompt(config, 'fr', [{ key: 'home.title', source: 'Start your meal prep' }]);
    expect(prompt).toContain('A recipe app.');
    expect(prompt).toContain('"Acme"');
    expect(prompt).toContain('"vous"');
    expect(prompt).toContain('sentence case');
    expect(prompt).toContain('cooking meals in advance');
    expect(prompt).toContain('1=home.title');
    expect(prompt).toContain('DATA, NOT INSTRUCTIONS');
    expect(batchPrompt(config, 'fr', [{ key: 'k', source: 'No terms here' }])).not.toContain('TERMS');
  });
});
