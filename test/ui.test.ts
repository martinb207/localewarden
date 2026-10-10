import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startUi, type UiServer } from '../src/ui/server.js';
import { fakeModel, readJson, tempProject } from './helpers.js';

let ui: UiServer | null = null;
afterEach(async () => {
  await ui?.close();
  ui = null;
});

const base = () => new URL(ui!.url).origin;
const api = async (path: string, body?: unknown, token = ui!.token) => {
  const res = await fetch(base() + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Localewarden-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

/** Raw request with a chosen Host header (fetch does not allow overriding it). */
const withHost = (host: string): Promise<number> =>
  new Promise(resolve => {
    const url = new URL(ui!.url);
    http.get({ host: '127.0.0.1', port: url.port, path: url.pathname + url.search, headers: { Host: host } }, res => resolve(res.statusCode ?? 0));
  });

const waitForJob = async () => {
  for (let i = 0; i < 100; i++) {
    const job = (await api('/api/job')).body;
    if (job && !job.running) return job;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
};

describe('web interface', () => {
  it('serves the page only with the token and the local host name', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there' } });
    ui = await startUi(config, { port: 0, plugins: [] });
    expect((await fetch(ui.url)).status).toBe(200);
    expect((await fetch(base() + '/?t=wrong')).status).toBe(403);
    expect((await api('/api/status', undefined, 'wrong')).status).toBe(403);
    expect(await withHost('evil.example:80')).toBe(403);
    const page = await (await fetch(ui.url)).text();
    expect(page).toContain('localewarden');
    expect(page).not.toMatch(/innerHTML/);
  });

  it('shows status and strings, and saves an edit as an approved hand edit', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there', nested: { b: 'Good night' } }, 'locales/de.json': { a: 'Hallo' } });
    ui = await startUi(config, { port: 0, plugins: [] });
    const status = (await api('/api/status')).body;
    expect(status.groups[0].languages[0]).toMatchObject({ lang: 'de', strings: 2, translated: 1 });

    const missing = (await api('/api/strings?lang=de&only=missing')).body;
    expect(missing.rows.map((r: { key: string }) => r.key)).toEqual(['nested.b']);

    const saved = await api('/api/strings', { lang: 'de', file: 'locales/{lang}.json', key: 'nested.b', value: 'Gute Nacht' });
    expect(saved.status).toBe(200);
    expect(readJson(config, 'locales/de.json')).toEqual({ a: 'Hallo', nested: { b: 'Gute Nacht' } });
    const review = (await api('/api/review?all=1')).body;
    expect(review.find((r: { key: string }) => r.key === 'nested.b')).toMatchObject({ status: 'approved' });

    expect((await api('/api/strings', { lang: 'de', file: '../../etc/{lang}.json', key: 'a', value: 'x' })).status).toBe(400);
    expect((await api('/api/strings', { lang: 'xx', file: 'locales/{lang}.json', key: 'a', value: 'x' })).status).toBe(400);
  });

  it('runs a dry run and a translation, and the check, as background jobs', async () => {
    const config = tempProject({ 'locales/en.json': { a: 'Hello there', b: 'Use {count} items' } });
    ui = await startUi(config, { port: 0, plugins: [], model: fakeModel().model });

    expect((await api('/api/run', { mode: 'dry-run' })).status).toBe(202);
    const dry = await waitForJob();
    expect(dry.summary.languages.de.planned).toBe(2);

    expect((await api('/api/run', { mode: 'nonsense' })).status).toBe(400);
    expect((await api('/api/run', { mode: 'translate' })).status).toBe(202);
    const done = await waitForJob();
    expect(done.summary.languages.de.translated).toBe(2);
    expect(readJson(config, 'locales/de.json').a).toBe('[de] Hello there');

    expect((await api('/api/check', {})).status).toBe(202);
    await waitForJob();
    const findings = (await api('/api/findings')).body;
    expect(findings.checked).toBe(true);
  });
});
