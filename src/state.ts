import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * creating: write-ahead record before the Orca call; created: Orca returned a pane; paired: an attach
 * process for this terminal was seen in Orca; failed: Orca refused the create (safe to retry later).
 */
export type EntryStatus = "creating" | "created" | "paired" | "failed";

export type Entry = {
  status: EntryStatus;
  herdrPaneId?: string;
  worktreePath?: string;
  method?: "tab" | "split" | "existing" | "manual";
  handle?: string | null;
  paneKey?: string | null;
  createdAt?: number;
  pairedAt?: number;
  failures?: number;
  lastFailedAt?: number;
  lastError?: string;
};

export type State = {
  version: 1;
  /** Lock-acquisition time of the last full sync; later-started waiters it already covered can skip. */
  lastSyncStartedAt: number;
  terminals: Record<string, Entry>;
  repoFailures: Record<string, { at: number; error: string }>;
  /** Orca panes this plugin created (paneKey -> herdr pane), kept while the Orca pane exists, to spot leftovers. */
  ownPanes: Record<string, { terminalId: string; paneId: string; createdAt: number }>;
  /**
   * Orca tab ids (or unique id prefixes) of tabs replaced by upgrade-tabs. Orca can respawn a shell in a
   * restored tab when its process exits, so such tabs are closed whenever they show up unattached.
   */
  retiredTabs: Record<string, { retiredAt: number }>;
};

export function emptyState(): State {
  return { version: 1, lastSyncStartedAt: 0, terminals: {}, repoFailures: {}, ownPanes: {}, retiredTabs: {} };
}

export function loadState(stateDir: string): State {
  let text: string;
  try {
    text = readFileSync(join(stateDir, "state.json"), "utf8");
  } catch {
    return emptyState();
  }
  const parsed = JSON.parse(text) as Partial<State>;
  if (parsed.version !== 1 || typeof parsed.terminals !== "object" || parsed.terminals === null) {
    throw new Error(`unsupported state file ${join(stateDir, "state.json")}`);
  }
  return { ...emptyState(), ...parsed } as State;
}

export function saveState(stateDir: string, state: State): void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "state.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const STALE_LOCK_MS = 120_000;
const UNWRITTEN_LOCK_MS = 5_000;

/** Exclusive cross-process lock (O_EXCL lock file). Stale locks from dead or hung holders are broken. */
export function withLock<T>(stateDir: string, fn: () => T, opts: { timeoutMs?: number } = {}): T {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, "sync.lock");
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder = 0;
      let age = 0;
      try {
        holder = Number(readFileSync(lockPath, "utf8").trim());
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue;
      }
      // A lock file without a pid yet is being written by its new holder; only treat it as stale when old.
      const unreadable = !Number.isInteger(holder) || holder <= 0;
      if ((unreadable && age > UNWRITTEN_LOCK_MS) || (!unreadable && !pidAlive(holder)) || age > STALE_LOCK_MS) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* another waiter broke it first */
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockPath} (held by pid ${holder})`);
      sleepMs(100);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}
