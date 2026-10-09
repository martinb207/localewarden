#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, CONFIG_FILE, loadConfig } from './config.js';
import { CHECKS } from './checks.js';
import { findSourceFiles } from './files.js';
import { isReasoningModel } from './llm.js';
import { checkProject, summaryTable } from './project.js';
import { listReview, updateReview } from './review.js';
import { run, type Logger } from './translate.js';

const HELP = `localewarden - incremental AI translation for JSON locale files

Usage:
  localewarden [translate] [options]   translate new and changed strings
  localewarden check [options]         quality check, no API calls (use in CI)
  localewarden review [options]        list and resolve hand-edited translations
  localewarden init                    create ${CONFIG_FILE}

Translate options:
  --dry-run              show what would be translated; no API calls, no writes
  --lang de,fr           only these languages
  --fix-flagged          let the model fix strings the quality check flags
  --retranslate-all      translate every string again (hand edits stay protected)
  --overwrite-manual     also replace hand-edited translations
  --max-tokens <n>       token budget for this run (default: maxTokensPerRun)
  --verbose              more output

Check options:
  --lang de,fr           only these languages
  --verbose, -v          list findings, not only counts
  --limit <n>            findings shown per check with --verbose (default 20)
  --strict               exit 1 on warnings too (default: only placeholder/script errors)
  --json                 print findings as JSON

Review options:
  --all                  include approved entries
  --approve <sel>...     the hand edit is correct: keep it protected
  --release <sel>...     hand it back: next run revises it from the source
                         <sel> = de:some.key | de:* | all

Global:
  --config <path>        config file (default ./${CONFIG_FILE})
  --help, --version
`;

interface Args {
  command: string;
  flags: Set<string>;
  values: Map<string, string[]>;
}

const VALUE_FLAGS = new Set(['--lang', '--max-tokens', '--config', '--limit', '--approve', '--release']);

function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'translate', flags: new Set(), values: new Map() };
  let commandSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (VALUE_FLAGS.has(name)) {
      const list = args.values.get(name) ?? [];
      if (inline !== undefined) list.push(inline);
      while (inline === undefined && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
        list.push(argv[++i]);
        if (name !== '--approve' && name !== '--release') break;
      }
      if (list.length === 0) throw new ConfigError(`${name} needs a value`);
      args.values.set(name, list);
    } else if (arg.startsWith('-')) {
      args.flags.add(arg === '-v' ? '--verbose' : arg === '-h' ? '--help' : arg);
    } else if (!commandSet) {
      args.command = arg;
      commandSet = true;
    } else {
      throw new ConfigError(`Unexpected argument: ${arg}`);
    }
  }
  return args;
}

const languagesArg = (args: Args): string[] | undefined =>
  args.values.get('--lang')?.flatMap(value => value.split(',')).map(l => l.trim()).filter(Boolean);

function version(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

const LAYOUTS = [
  'locales/{lang}.json',
  'locales/{lang}/*.json',
  'src/locales/{lang}.json',
  'src/locales/{lang}/*.json',
  'src/i18n/locales/{lang}.json',
  'src/i18n/locales/{lang}/*.json',
  'src/i18n/{lang}.json',
  'public/locales/{lang}/*.json',
  'messages/{lang}.json',
  'src/assets/i18n/{lang}.json',
  'i18n/{lang}.json',
  'lang/{lang}.json',
];

function init(): void {
  const file = path.resolve(CONFIG_FILE);
  if (fs.existsSync(file)) {
    console.log(`${CONFIG_FILE} already exists.`);
    return;
  }
  const layout = LAYOUTS.find(pattern => findSourceFiles(process.cwd(), pattern, 'en').length > 0);
  const config = {
    sourceLanguage: 'en',
    targetLanguages: ['de', 'fr', 'es'],
    files: layout ?? 'locales/{lang}.json',
    context: 'Describe your product in one or two sentences, e.g. "A budgeting app for freelancers."',
    tone: 'friendly and plain',
    doNotTranslate: [],
    formality: { de: 'informal', fr: 'formal', es: 'informal' },
    glossary: {},
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  console.log(`Created ${CONFIG_FILE}${layout ? ` (found locale files at ${layout})` : ''}.`);
  console.log('Next: edit "context", "targetLanguages" and "files", then run "npx localewarden --dry-run".');
}

function makeLogger(verbose: boolean): Logger {
  return {
    info: message => console.log(message),
    warn: message => console.warn(`warning: ${message}`),
    error: message => console.error(`error: ${message}`),
    debug: verbose ? message => console.log(message) : undefined,
  };
}

async function translateCommand(args: Args): Promise<number> {
  const config = loadConfig(args.values.get('--config')?.[0]);
  const maxTokens = args.values.get('--max-tokens')?.[0];
  if (maxTokens !== undefined && !(Number(maxTokens) > 0)) throw new ConfigError('--max-tokens must be a positive number');
  const summary = await run(config, {
    languages: languagesArg(args),
    dryRun: args.flags.has('--dry-run'),
    retranslateAll: args.flags.has('--retranslate-all'),
    overwriteManual: args.flags.has('--overwrite-manual'),
    fixFlagged: args.flags.has('--fix-flagged'),
    maxTokens: maxTokens === undefined ? undefined : Number(maxTokens),
    logger: makeLogger(args.flags.has('--verbose')),
  });

  console.log('');
  if (summary.dryRun) {
    const strings = Object.values(summary.languages).reduce((sum, l) => sum + l.planned, 0);
    const chars = Object.values(summary.languages).reduce((sum, l) => sum + l.plannedChars, 0);
    if (strings === 0) {
      console.log('Dry run: everything is up to date.');
      return 0;
    }
    // Rough: prompt overhead per request plus input and output text (~4 characters per token).
    const requests = Math.ceil(strings / config.batchSize) + Math.ceil(strings * 0.05);
    const low = Math.round(requests * 900 + (chars / 4) * 2.2);
    const high = Math.round(low * (isReasoningModel(config.model) ? 3 : 1.5));
    console.log(`Dry run: ${strings} string(s), ${chars.toLocaleString('en')} characters to translate.`);
    console.log(`Rough estimate: ${low.toLocaleString('en')} to ${high.toLocaleString('en')} tokens with ${config.model}. Budget per run: ${(maxTokens ? Number(maxTokens) : config.maxTokensPerRun).toLocaleString('en')}.`);
    return 0;
  }

  const rows = Object.entries(summary.languages).filter(([, s]) => s.translated + s.revised + s.repaired + s.failed + s.protected + s.removed > 0);
  for (const [lang, s] of rows) {
    const parts = [
      `${s.translated} translated`,
      s.revised && `${s.revised} revised`,
      s.repaired && `${s.repaired} repaired`,
      s.failed && `${s.failed} failed`,
      s.protected && `${s.protected} new hand edit(s) kept`,
      s.removed && `${s.removed} removed`,
    ].filter(Boolean);
    console.log(`${lang.padEnd(6)} ${parts.join(', ')}`);
  }
  if (rows.length === 0) console.log('Everything is up to date.');
  console.log(`\n${summary.filesWritten.length} file(s) written, ${summary.requests} request(s), ${summary.tokens.toLocaleString('en')} tokens.`);
  if (summary.stoppedByBudget) console.log('Stopped at the token budget. Run again to continue.');
  if (summary.pendingReview > 0) console.log(`${summary.pendingReview} hand-edited translation(s) to review: npx localewarden review`);
  const failed = Object.values(summary.languages).some(s => s.failed > 0);
  if (failed) console.log('Failed strings were not written and will be retried on the next run.');
  return 0;
}

function checkCommand(args: Args): number {
  const config = loadConfig(args.values.get('--config')?.[0]);
  const languages = languagesArg(args) ?? config.targetLanguages;
  const findings = checkProject(config, languages);
  if (args.flags.has('--json')) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    console.log(summaryTable(findings, languages));
    if (args.flags.has('--verbose')) {
      const limit = Number(args.values.get('--limit')?.[0] ?? 20);
      for (const check of CHECKS) {
        const items = findings.filter(f => f.check === check);
        if (items.length === 0) continue;
        console.log(`\n== ${check} (${items.length})`);
        for (const f of items.slice(0, limit)) {
          console.log(`  [${f.lang}] ${f.file} ${f.key}${f.note ? ` - ${f.note}` : ''}\n      ${f.text.slice(0, 300)}`);
        }
        if (items.length > limit) console.log(`  ... ${items.length - limit} more (--limit <n>)`);
      }
    }
    const errors = findings.filter(f => f.severity === 'error').length;
    console.log(`\n${errors} error(s), ${findings.length - errors} warning(s).${findings.length && !args.flags.has('--verbose') ? ' Details: --verbose' : ''}`);
  }
  const errors = findings.some(f => f.severity === 'error');
  return errors || (args.flags.has('--strict') && findings.length > 0) ? 1 : 0;
}

function reviewCommand(args: Args): number {
  const config = loadConfig(args.values.get('--config')?.[0]);
  for (const action of ['approve', 'release'] as const) {
    const selectors = args.values.get(`--${action}`);
    if (selectors) {
      const changed = updateReview(config, action, selectors);
      console.log(`${action === 'approve' ? 'Approved' : 'Released'} ${changed} entr${changed === 1 ? 'y' : 'ies'}.`);
      return 0;
    }
  }
  const items = listReview(config, args.flags.has('--all'));
  if (items.length === 0) {
    console.log('Nothing to review.');
    return 0;
  }
  for (const item of items) {
    console.log(`${item.status === 'pending' ? 'PENDING ' : 'approved'} ${item.lang}:${item.key}  (${item.reason}, since ${item.since}, ${item.file})`);
    if (item.value !== undefined) console.log(`         ${item.value.slice(0, 200)}`);
  }
  console.log('\nApprove with: npx localewarden review --approve de:<key>   (or de:*, all)');
  console.log('Hand back:    npx localewarden review --release de:<key>');
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('--help')) {
    console.log(HELP);
    return 0;
  }
  if (args.flags.has('--version')) {
    console.log(version());
    return 0;
  }
  switch (args.command) {
    case 'translate':
      return translateCommand(args);
    case 'check':
      return checkCommand(args);
    case 'review':
      return reviewCommand(args);
    case 'init':
      init();
      return 0;
    default:
      throw new ConfigError(`Unknown command "${args.command}". See --help.`);
  }
}

main().then(
  code => {
    process.exitCode = code;
  },
  (error: Error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = error instanceof ConfigError ? 2 : 1;
  }
);
