import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../config.js';
import type { Model } from '../llm.js';
import { LockError } from '../lock.js';
import { listReview, updateReview } from '../review.js';
import { checkProject, type Finding } from '../project.js';
import { loadPlugins, PluginHost, type Plugin } from '../plugins.js';
import { run, type RunSummary } from '../translate.js';
import { editString, status, strings } from './data.js';
import { PAGE } from './page.js';

export interface UiOptions {
  /** Port on 127.0.0.1; 0 picks a free one. Default 4848. */
  port?: number;
  plugins?: Plugin[];
  /** Model for runs started from the interface (tests). */
  model?: Model;
  /** Access token; random by default. */
  token?: string;
}

export interface UiServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

interface Job {
  kind: 'run' | 'check';
  running: boolean;
  lines: string[];
  /** Lines dropped from the front (only the last 5000 are kept). */
  dropped: number;
  summary?: RunSummary;
  findings?: Finding[];
  error?: string;
  started: string;
}

const MAX_BODY = 1_000_000;

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Body must be JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Local web interface: overview, strings with inline editing, check findings, review list,
 * and runs with live log. Listens on 127.0.0.1 only; every request needs the random token
 * from the printed URL (page) or the X-Localewarden-Token header (API), and the Host header
 * must be the local address, which blocks other websites and DNS rebinding.
 */
export async function startUi(config: Config, options: UiOptions = {}): Promise<UiServer> {
  const token = options.token ?? randomBytes(18).toString('base64url');
  const plugins = new PluginHost(options.plugins ?? (await loadPlugins(config)));
  let job: Job | null = null;
  let lastCheck: Finding[] | null = null;
  let port = 0;

  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json') => {
    res.writeHead(code, {
      'Content-Type': `${type}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
  };

  const startJob = (kind: Job['kind'], work: (log: (line: string) => void) => Promise<Partial<Job>>) => {
    job = { kind, running: true, lines: [], dropped: 0, started: new Date().toISOString() };
    const current = job;
    const log = (line: string) => {
      current.lines.push(line);
      if (current.lines.length > 5000) {
        const excess = current.lines.length - 5000;
        current.lines.splice(0, excess);
        current.dropped += excess;
      }
    };
    work(log)
      .then(result => Object.assign(current, result))
      .catch((error: Error) => {
        current.error = error.message;
      })
      .finally(() => {
        current.running = false;
      });
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'Wrong host.' });

      if (url.pathname === '/' && req.method === 'GET') {
        if (!sameToken(url.searchParams.get('t') ?? '', token)) return send(res, 403, 'Open the URL printed by "localewarden ui" (it contains the access token).', 'text/plain');
        return send(res, 200, PAGE, 'text/html');
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
      if (!sameToken(String(req.headers['x-localewarden-token'] ?? ''), token)) return send(res, 403, { error: 'Missing or wrong token.' });

      const route = `${req.method} ${url.pathname}`;
      const q = url.searchParams;
      switch (route) {
        case 'GET /api/status':
          return send(res, 200, { ...status(config, plugins), job: job && { kind: job.kind, running: job.running } });
        case 'GET /api/strings':
          return send(res, 200, strings(config, plugins, {
            group: q.get('group') || undefined,
            lang: q.get('lang') ?? '',
            q: q.get('q') || undefined,
            only: (q.get('only') || undefined) as 'missing' | 'pending-review' | undefined,
            limit: Number(q.get('limit') ?? 200),
          }));
        case 'POST /api/strings': {
          if (job?.running && job.kind === 'run') return send(res, 409, { error: 'A run is in progress; edit after it finished.' });
          const body = (await readBody(req)) as { group?: string; lang: string; file: string; key: string; value: string };
          return send(res, 200, editString(config, plugins, body));
        }
        case 'GET /api/review':
          return send(res, 200, listReview(config, q.get('all') === '1'));
        case 'POST /api/review': {
          const body = (await readBody(req)) as { action: 'approve' | 'release'; selectors: string[] };
          if (body.action !== 'approve' && body.action !== 'release') return send(res, 400, { error: 'action must be approve or release.' });
          if (!Array.isArray(body.selectors) || !body.selectors.every(s => typeof s === 'string')) return send(res, 400, { error: 'selectors must be a list.' });
          return send(res, 200, { changed: updateReview(config, body.action, body.selectors) });
        }
        case 'GET /api/findings': {
          const filter = (f: Finding) =>
            (!q.get('lang') || f.lang === q.get('lang')) && (!q.get('check') || f.check === q.get('check')) && (!q.get('group') || f.group === q.get('group'));
          const all = lastCheck ?? [];
          const rows = all.filter(filter);
          return send(res, 200, { checked: lastCheck !== null, total: rows.length, rows: rows.slice(0, Number(q.get('limit') ?? 300)) });
        }
        case 'POST /api/check': {
          if (job?.running) return send(res, 409, { error: 'Something is already running.' });
          startJob('check', async log => {
            log('Checking all translations…');
            const findings = checkProject(config, { plugins: plugins.plugins });
            lastCheck = findings;
            log(`${findings.length} finding(s).`);
            return { findings: [] };
          });
          return send(res, 202, { started: true });
        }
        case 'POST /api/run': {
          if (job?.running) return send(res, 409, { error: 'Something is already running.' });
          const body = (await readBody(req)) as { mode?: string; groups?: string[]; languages?: string[] };
          const mode = body.mode ?? 'dry-run';
          if (!['dry-run', 'translate', 'fix-flagged'].includes(mode)) return send(res, 400, { error: 'mode must be dry-run, translate or fix-flagged.' });
          startJob('run', async log => {
            const summary = await run(config, {
              dryRun: mode === 'dry-run',
              fixFlagged: mode === 'fix-flagged',
              groups: body.groups?.length ? body.groups : undefined,
              languages: body.languages?.length ? body.languages : undefined,
              plugins: plugins.plugins,
              model: options.model,
              logger: { info: log, warn: m => log(`warning: ${m}`), error: m => log(`error: ${m}`) },
            });
            return { summary };
          });
          return send(res, 202, { started: true });
        }
        case 'GET /api/job':
          if (!job) return send(res, 200, null);
          {
            // `from` counts all lines ever logged; the oldest may have been dropped.
            const from = Math.max(0, Number(q.get('from') ?? 0) - job.dropped);
            return send(res, 200, { ...job, findings: undefined, lines: job.lines.slice(from), lineCount: job.dropped + job.lines.length });
          }
        default:
          return send(res, 404, { error: 'Not found.' });
      }
    } catch (error) {
      // A run (here or in another process) holds the lock: try again when it is done.
      if (error instanceof LockError) return send(res, 409, { error: error.message });
      return send(res, 400, { error: (error as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4848, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    token,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
