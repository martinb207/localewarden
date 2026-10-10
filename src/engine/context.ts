import { Budget, BudgetExceededError } from '../budget.js';
import { FatalModelError, type Model } from '../llm.js';
import type { Plugin } from '../plugins.js';
import { PluginHost } from '../plugins.js';
import type { State } from '../state.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export const consoleLogger: Logger = {
  info: message => console.log(message),
  warn: message => console.warn(`warning: ${message}`),
  error: message => console.error(`error: ${message}`),
};

export interface RunOptions {
  /** Subset of the configured target languages. */
  languages?: string[];
  /** Only these groups (by name); default all, in config order. */
  groups?: string[];
  /** Show what would be translated; no API calls, no writes. */
  dryRun?: boolean;
  /** Re-translate every string, not only new and changed ones. Hand edits stay protected. */
  retranslateAll?: boolean;
  /** Re-translate every string of files matching these path patterns (hand edits stay protected). */
  retranslateFiles?: string[];
  /** Re-translate strings localewarden last wrote before this day (YYYY-MM-DD), or adopted. */
  refreshBefore?: string;
  /** Also replace hand-edited translations. */
  overwriteManual?: boolean;
  /** Ask the model to fix strings the quality check flags, changing as little as possible. */
  fixFlagged?: boolean;
  /** Overrides maxTokensPerRun from the config. */
  maxTokens?: number;
  logger?: Logger;
  /** Model to use instead of the configured OpenAI-compatible endpoint (tests, other SDKs). */
  model?: Model;
  /** Plugins to use instead of loading the ones listed in the config. */
  plugins?: Plugin[];
}

export interface LanguageSummary {
  translated: number;
  revised: number;
  repaired: number;
  failed: number;
  protected: number;
  removed: number;
  planned: number;
  plannedChars: number;
}

export interface RunSummary {
  languages: Record<string, LanguageSummary>;
  filesWritten: string[];
  /** Copies written (see `copies` in the config). */
  filesCopied: string[];
  tokens: number;
  requests: number;
  stoppedByBudget: boolean;
  /** Why the run stopped early, when it did. */
  stopReason?: string;
  pendingReview: number;
  dryRun: boolean;
}

export const emptyLanguageSummary = (): LanguageSummary => ({
  translated: 0,
  revised: 0,
  repaired: 0,
  failed: 0,
  protected: 0,
  removed: 0,
  planned: 0,
  plannedChars: 0,
});

/** What every part of a run shares: options, state, budget, plugins and the summary. */
export class RunContext {
  readonly summary: RunSummary;
  private fatal: Error | null = null;

  constructor(
    readonly options: RunOptions,
    readonly log: Logger,
    readonly state: State,
    readonly budget: Budget,
    readonly plugins: PluginHost
  ) {
    this.summary = {
      languages: {},
      filesWritten: [],
      filesCopied: [],
      tokens: 0,
      requests: 0,
      stoppedByBudget: false,
      pendingReview: 0,
      dryRun: Boolean(options.dryRun),
    };
  }

  get dryRun(): boolean {
    return this.summary.dryRun;
  }

  counts(lang: string): LanguageSummary {
    return (this.summary.languages[lang] ??= emptyLanguageSummary());
  }

  /** True once the budget is used up or the API refused the requests for good. */
  get stopped(): boolean {
    return this.fatal !== null || this.summary.stoppedByBudget;
  }

  /** Records an API error: budget and fatal errors stop the run, others are logged. */
  handleError(error: unknown, lang: string): void {
    if (error instanceof BudgetExceededError) {
      if (!this.summary.stoppedByBudget) this.log.warn(`${error.message}; stopping. Run again to continue.`);
      this.summary.stoppedByBudget = true;
      this.summary.stopReason = error.message;
    } else if (error instanceof FatalModelError) {
      this.fatal ??= error;
    } else {
      this.log.warn(`[${lang}] ${(error as Error).message}`);
    }
  }

  /** Throws the fatal API error, if there was one. */
  rethrow(): void {
    if (this.fatal) throw this.fatal;
  }
}

export { BudgetExceededError };
