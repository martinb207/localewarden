import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, LockError } from '../src/lock.js';
import { run } from '../src/translate.js';
import { fakeModel, silent, tempProject } from './helpers.js';

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('file formats', () => {
  it('keeps Windows line endings and a byte order mark', async () => {
    const config = tempProject({
      'locales/en.json': '﻿{\r\n  "a": "Hello there",\r\n  "b": "Good night"\r\n}\r\n',
      'locales/de.json': '﻿{\r\n  "a": "Hallo zusammen"\r\n}\r\n',
    });
    await run(config, { model: fakeModel().model, logger: silent });
    expect(read(config.root, 'locales/de.json')).toBe('﻿{\r\n  "a": "Hallo zusammen",\r\n  "b": "[de] Good night"\r\n}\r\n');
  });

  it('keeps line endings of text files', async () => {
    const config = tempProject({ 'store/en/description.txt': 'Line one\r\nLine two\r\n' }, { files: 'store/{lang}/*.txt' });
    await run(config, { model: fakeModel().model, logger: silent });
    expect(read(config.root, 'store/de/description.txt')).toBe('[de] Line one\r\nLine two\r\n');
  });

  it('does not take a different Unicode normalization for a hand edit', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Coffee break' }, 'locales/de.json': { a: 'Kaffeepause café' } });
    await run(config, { model: fakeModel().model, logger: silent });
    // An editor saves the same text decomposed (e + combining accent).
    fs.writeFileSync(path.join(config.root, 'locales/de.json'), JSON.stringify({ a: 'Kaffeepause café'.normalize('NFD') }));
    const summary = await run(config, { model: fakeModel().model, logger: silent });
    expect(summary.languages.de?.protected ?? 0).toBe(0);
  });

  it('warns about a dotted key that collides with a nested one', async () => {
    const config = tempProject({ 'locales/en.json': { 'a.b': 'Dotted key text', a: { b: 'Nested key text' } } });
    const warnings: string[] = [];
    await run(config, { model: fakeModel().model, logger: { ...silent, warn: m => warnings.push(m) } });
    expect(warnings.some(w => w.includes('exists twice'))).toBe(true);
  });

  it('finds locale folders behind symbolic links and survives link loops', async () => {
    const config = tempProject({ 'shared/en.json': { a: 'Hello there' } }, { files: 'locales/{lang}.json' });
    fs.symlinkSync(path.join(config.root, 'shared'), path.join(config.root, 'locales'));
    fs.symlinkSync(config.root, path.join(config.root, 'shared', 'loop'));
    await run(config, { model: fakeModel().model, logger: silent });
    expect(JSON.parse(read(config.root, 'shared/de.json')).a).toBe('[de] Hello there');
  });

  it('leaves no temporary files behind', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' } });
    await run(config, { model: fakeModel().model, logger: silent });
    const all = fs.readdirSync(config.root, { recursive: true }) as string[];
    expect(all.filter(f => f.includes('localewarden-tmp'))).toEqual([]);
    expect(all.some(f => f.endsWith('run.lock'))).toBe(false);
  });
});

describe('lock and state', () => {
  it('refuses a second run while one is active and replaces a stale lock', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' } });
    const stateDir = path.join(config.root, '.localewarden');
    fs.mkdirSync(stateDir, { recursive: true });
    // The parent process (the test runner) is alive.
    fs.writeFileSync(path.join(stateDir, 'run.lock'), JSON.stringify({ pid: process.ppid, started: 'now' }));
    await expect(run(config, { model: fakeModel().model, logger: silent })).rejects.toThrow(LockError);

    fs.writeFileSync(path.join(stateDir, 'run.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, started: 'long ago' }));
    await run(config, { model: fakeModel().model, logger: silent });
    expect(fs.existsSync(path.join(stateDir, 'run.lock'))).toBe(false);
  });

  it('a dry run needs no lock', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' } });
    const release = acquireLock(path.join(config.root, '.localewarden'));
    const summary = await run(config, { model: fakeModel().model, logger: silent, dryRun: true });
    expect(summary.languages.de.planned).toBe(1);
    release();
  });

  it('explains a corrupt state file and releases the lock', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' }, '.localewarden/state.json': '{ broken' });
    await expect(run(config, { model: fakeModel().model, logger: silent })).rejects.toThrow(/restore it from git, or delete it/);
    expect(fs.existsSync(path.join(config.root, '.localewarden/run.lock'))).toBe(false);
  });
});
