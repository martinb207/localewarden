import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class LockError extends Error {}

interface Holder {
  pid?: number;
  host?: string;
  started?: string;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readHolder = (file: string): Holder | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Holder;
  } catch {
    return null;
  }
};

/**
 * Takes <stateDir>/run.lock so two runs (say, CI and a local run), or a run and an edit in the
 * web interface, cannot write the same state at once. Only one holder at a time, including
 * within one process. A lock is stale when its process no longer exists on this machine, or
 * when it was written on another machine (a lock file committed by mistake); a stale lock is
 * taken over with an atomic rename, so two processes cannot both take it. Returns the
 * function that releases it.
 */
export function acquireLock(stateDir: string): () => void {
  const file = path.join(stateDir, 'run.lock');
  fs.mkdirSync(stateDir, { recursive: true });
  const me: Holder = { pid: process.pid, host: os.hostname(), started: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify(me));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const holder = readHolder(file);
        if (holder && holder.pid === me.pid && holder.started === me.started) fs.rmSync(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readHolder(file);
      const sameHost = !holder?.host || holder.host === os.hostname();
      if (holder && holder.pid && sameHost && alive(holder.pid)) {
        throw new LockError(
          `Another localewarden run is active (pid ${holder.pid}, started ${holder.started ?? 'at an unknown time'}). ` +
            `Wait for it to finish; if no run is active, delete ${file}.`
        );
      }
      // Stale: move it aside atomically. If another process got there first, the rename fails
      // and the next attempt sees their fresh lock.
      const aside = `${file}.stale-${process.pid}-${attempt}`;
      try {
        fs.renameSync(file, aside);
        const moved = readHolder(aside);
        if (moved && holder && (moved.pid !== holder.pid || moved.started !== holder.started)) {
          // We moved someone's fresh lock: put it back and stop.
          fs.renameSync(aside, file);
          throw new LockError(`Another localewarden run just started (pid ${moved.pid}).`);
        }
        fs.rmSync(aside, { force: true });
      } catch (renameError) {
        if (renameError instanceof LockError) throw renameError;
        // ENOENT: someone else took it over; try again.
      }
    }
  }
  throw new LockError(`Could not take the lock ${file}.`);
}

/** Runs `fn` while holding the lock (for short writes like review approvals and edits). */
export function withLock<T>(stateDir: string, fn: () => T): T {
  const release = acquireLock(stateDir);
  try {
    return fn();
  } finally {
    release();
  }
}
