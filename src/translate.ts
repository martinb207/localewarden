import path from 'node:path';
import { Budget } from './budget.js';
import { Checker } from './checks.js';
import { selectGroups, type Config } from './config.js';
import { applyCopies } from './engine/copies.js';
import { consoleLogger, RunContext, type RunOptions, type RunSummary } from './engine/context.js';
import { planFile, type Plan } from './engine/planner.js';
import { runRepairs } from './engine/repair.js';
import { listFiles, loadSources } from './engine/sources.js';
import { Translator } from './engine/translator.js';
import { applyTranslations, writePlan } from './engine/writer.js';
import { Client, OpenAICompatibleModel, type Model } from './llm.js';
import { acquireLock } from './lock.js';
import { loadPlugins, PluginHost } from './plugins.js';
import type { PromptItem } from './prompt.js';
import { Scope } from './scope.js';
import { State } from './state.js';
import { inParallel } from './util.js';

export { consoleLogger, type Logger, type LanguageSummary, type RunOptions, type RunSummary } from './engine/context.js';
export { changedWords, tooManyChanges } from './engine/repair.js';

const noModel: Model = { complete: async () => ({ text: '', tokens: 0 }) };

/**
 * Translates new and changed strings, group by group (in config order), language by language.
 * Within a language, all files of a group share requests, so many small files do not cost a
 * request each. See engine/planner.ts for what is translated, revised, adopted or protected.
 */
export async function run(config: Config, options: RunOptions = {}): Promise<RunSummary> {
  const log = options.logger ?? consoleLogger;
  const groups = selectGroups(config, options.groups, options.languages);

  const dryRun = Boolean(options.dryRun);
  if (!options.model && !dryRun) {
    const needsKey = groups.find(g => !process.env[g.apiKeyEnv] && g.baseUrl.includes('api.openai.com'));
    if (needsKey) throw new Error(`Set the ${needsKey.apiKeyEnv} environment variable to your OpenAI API key (or run with --dry-run).`);
  }

  const stateDir = path.join(config.root, config.stateDir);
  const plugins = new PluginHost(options.plugins ?? (await loadPlugins(config)));
  const budget = new Budget(options.maxTokens ?? config.maxTokensPerRun, config.dailyTokenBudget, path.join(stateDir, 'usage.json'));
  const release = dryRun ? () => {} : acquireLock(stateDir);
  let state: State;
  try {
    state = new State(stateDir);
  } catch (error) {
    release();
    throw error;
  }
  const ctx = new RunContext(options, log, state, budget, plugins);
  // Ctrl+C or a CI timeout: keep what was translated so far, then stop.
  const onSignal = (signal: NodeJS.Signals) => {
    log.warn(`${signal}: saving progress and stopping.`);
    if (!dryRun) state.save();
    release();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (!dryRun && budget.exceeded) {
    log.warn(`${budget.exceeded}; nothing to do until tomorrow (UTC).`);
    ctx.summary.stoppedByBudget = true;
    ctx.summary.stopReason = budget.exceeded;
  }

  try {
    for (const raw of groups) {
      if (ctx.stopped) break;
      let group = raw;
      if (group.context?.startsWith('Describe your product')) {
        log.warn('"context" still has the example text from init; it is ignored. Describe your product in localewarden.config.json for better translations.');
        group = { ...group, context: undefined };
      }
      await runGroup(ctx, group, options.model);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    try {
      if (!dryRun) state.save();
    } finally {
      release();
    }
  }

  ctx.summary.tokens = budget.tokens;
  ctx.summary.requests = budget.requests;
  ctx.summary.pendingReview = Object.values(state.review).filter(entry => entry.status === 'pending').length;
  ctx.rethrow();
  return ctx.summary;
}

async function runGroup(ctx: RunContext, group: Config, model: Model | undefined): Promise<void> {
  const { log, options } = ctx;
  const scope = new Scope(group);
  const checker = new Checker(group, ctx.plugins);
  const files = listFiles(group, scope, ctx.plugins);
  if (files.length === 0) {
    const label = group.name ? `Group "${group.name}": no` : 'No';
    if (group.groups || group.name) log.warn(`${label} ${group.sourceLanguage} files match "${group.files}".`);
    else throw new Error(`No ${group.sourceLanguage} files match "${group.files}" under ${group.root}.`);
    return;
  }
  if (group.name) log.info(`== ${group.name}`);
  const client = new Client(model ?? (ctx.dryRun ? noModel : new OpenAICompatibleModel(group)), ctx.budget, {
    onRetry: message => log.warn(message),
  });
  const translator = new Translator(ctx, group, checker, client);
  const sources = loadSources(group, files, log);
  const languages = group.targetLanguages.filter(lang => !options.languages?.length || options.languages.includes(lang));

  await inParallel(languages, group.concurrency, async lang => {
    if (ctx.stopped) return;
    const plans = sources.map(source => planFile(ctx, { config: group, scope, checker }, source, lang)).filter((p): p is Plan => p !== null);
    const counts = ctx.counts(lang);
    if (ctx.dryRun) {
      for (const plan of plans) {
        counts.planned += plan.work.length + plan.repairs.length;
        counts.plannedChars += [...plan.work, ...plan.repairs].reduce((sum, item) => sum + item.source.length, 0);
        counts.removed += plan.removed.length;
      }
      return;
    }
    const work = plans.flatMap(plan => plan.work);
    const translated = work.length > 0 ? await translator.translateItems(lang, work) : new Map<PromptItem, string>();
    for (const plan of plans) {
      applyTranslations(ctx, plan, translated);
      await runRepairs(ctx, plan, checker, scope, translator);
      writePlan(ctx, plan);
    }
    ctx.state.save();
  });

  if (!ctx.stopped) applyCopies(ctx, group, files);
}
