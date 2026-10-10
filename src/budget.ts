import fs from 'node:fs';
import { writeText } from './files.js';

export class BudgetExceededError extends Error {}

interface Usage {
  /** UTC day (YYYY-MM-DD) the counters belong to. */
  date: string;
  tokens: number;
  requests: number;
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);

/**
 * Token budget shared by every request of a run: a limit for the run and, optionally, a
 * limit per UTC day that holds across runs (for scheduled jobs). Daily usage is kept in a
 * small JSON file; a run that crosses midnight starts counting the new day.
 */
export class Budget {
  /** Tokens and requests of this run. */
  tokens = 0;
  requests = 0;
  private usage: Usage;

  constructor(
    readonly maxRunTokens: number,
    readonly dailyTokens?: number,
    private readonly usageFile?: string
  ) {
    this.usage = this.load();
  }

  private load(): Usage {
    if (this.usageFile) {
      try {
        const data = JSON.parse(fs.readFileSync(this.usageFile, 'utf8')) as Usage;
        if (data.date === utcDay()) return data;
      } catch {
        // missing or unreadable: start the day at zero
      }
    }
    return { date: utcDay(), tokens: 0, requests: 0 };
  }

  /** Tokens used today, including earlier runs. */
  get usedToday(): number {
    if (this.usage.date !== utcDay()) this.usage = { date: utcDay(), tokens: 0, requests: 0 };
    return this.usage.tokens;
  }

  /** Why no further request may start, or null. */
  get exceeded(): string | null {
    if (this.tokens >= this.maxRunTokens) return `token budget of ${this.maxRunTokens.toLocaleString('en')} for this run reached`;
    if (this.dailyTokens !== undefined && this.usedToday >= this.dailyTokens) {
      return `daily token budget of ${this.dailyTokens.toLocaleString('en')} reached (${this.usedToday.toLocaleString('en')} used today)`;
    }
    return null;
  }

  /** Throws when the budget is used up. Called before each request. */
  check(): void {
    const reason = this.exceeded;
    if (reason) throw new BudgetExceededError(reason);
  }

  record(tokens: number): void {
    this.tokens += tokens;
    this.requests++;
    this.usedToday; // rolls the day over if midnight passed
    this.usage.tokens += tokens;
    this.usage.requests++;
    if (this.usageFile) {
      try {
        writeText(this.usageFile, JSON.stringify(this.usage, null, 2) + '\n');
      } catch {
        // not fatal: the run limit still applies
      }
    }
  }
}
