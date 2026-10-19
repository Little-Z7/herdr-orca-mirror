import { fileURLToPath } from "node:url";
import { asRecord, parseJson, str, type Runner } from "./run.ts";

export type OrcaTerminal = {
  handle: string;
  paneKey: string | null;
  worktreeId: string | null;
  worktreePath: string | null;
  title: string | null;
  orphaned: boolean;
  agentIdentity?: string | null;
  preview?: string | null;
};
export type OrcaRepo = { id: string; path: string; externalWorktreeVisibility: string | null };
export type SplitDirection = "horizontal" | "vertical";
export type CreatedTerminal = { handle: string; paneKey: string | null };

/** An Orca call failed. `ambiguous` means Orca may still have applied it (timeout, unreadable reply). */
export class OrcaCommandError extends Error {
  ambiguous: boolean;
  constructor(message: string, ambiguous: boolean) {
    super(message);
    this.ambiguous = ambiguous;
  }
}

/** Orphaned rows report a `pty:` placeholder tab; the real pane key lives in recordedPaneKey. */
export function paneKeyOf(t: Record<string, unknown>): string | null {
  const recorded = str(t, "recordedPaneKey");
  if (recorded) return recorded;
  const tabId = str(t, "tabId");
  const leafId = str(t, "leafId");
  if (!tabId || !leafId || tabId.includes(":")) return null;
  return `${tabId}:${leafId}`;
}

export function parseTerminalList(value: unknown): { terminals: OrcaTerminal[]; truncated: boolean } {
  const result = asRecord(asRecord(value)?.result);
  if (!result || !Array.isArray(result.terminals)) throw new Error("orca terminal list: unexpected response shape");
  const terminals: OrcaTerminal[] = [];
  for (const item of result.terminals) {
    const t = asRecord(item);
    const handle = str(t, "handle");
    if (!t || !handle) continue;
    terminals.push({
      handle,
      paneKey: paneKeyOf(t),
      worktreeId: str(t, "worktreeId"),
      worktreePath: str(t, "worktreePath"),
      title: str(t, "title"),
      orphaned: t.orphaned === true,
      agentIdentity: str(t, "agentIdentity"),
      preview: typeof t.preview === "string" ? t.preview : null,
    });
  }
  return { terminals, truncated: result.truncated === true };
}

export function parseRepoList(value: unknown): OrcaRepo[] {
  const result = asRecord(asRecord(value)?.result);
  if (!result || !Array.isArray(result.repos)) throw new Error("orca repo list: unexpected response shape");
  return result.repos.flatMap((item) => {
    const r = asRecord(item);
    const id = str(r, "id");
    const path = str(r, "path");
    return id && path ? [{ id, path, externalWorktreeVisibility: str(r, "externalWorktreeVisibility") }] : [];
  });
}

export type OrcaStatus = { reachable: boolean; appVersion: string | null; state: string | null };

export type OrcaCli = {
  status(): OrcaStatus;
  reachable(): boolean;
  listTerminals(): { terminals: OrcaTerminal[]; truncated: boolean };
  listRepos(): OrcaRepo[];
  /** Paths of worktrees Orca shows in its sidebar. */
  listWorktreePaths(): string[];
  addRepo(path: string): OrcaRepo;
  showExternalWorktrees(repoId: string): void;
  createTerminal(opts: { worktreePath: string; title: string; command: string }): CreatedTerminal;
  splitTerminal(opts: { handle: string; direction: SplitDirection; command: string }): CreatedTerminal;
  closeTab(handle: string): void;
  /**
   * Show one non-Orca worktree in the sidebar (Orca's per-worktree "show in sidebar"). Not in the public
   * CLI: goes through Orca's runtime RPC `repo.update` (importedExternalWorktreePaths).
   */
  importWorktree(repoId: string, path: string): void;
};

/** `<Orca.app>` resolved from the `orca` launcher, which lives at `<Orca.app>/Contents/Resources/bin/orca`. */
export function orcaAppFromLauncher(launcherRealPath: string): string | null {
  const i = launcherRealPath.indexOf(".app/");
  return i === -1 ? null : launcherRealPath.slice(0, i + 4);
}

export function orcaCli(run: Runner, bin = "orca"): OrcaCli {
  const call = (args: string[], timeoutMs = 30_000): Record<string, unknown> => {
    const r = run([bin, ...args, "--json"], { timeoutMs });
    const envelope = asRecord(parseJson(r.stdout)) ?? asRecord(parseJson(r.stderr));
    if (envelope?.ok === true) return asRecord(envelope.result) ?? {};
    const label = `orca ${args.slice(0, 2).join(" ")}`;
    if (!envelope || r.status === null) {
      throw new OrcaCommandError(`${label}: no readable reply (${(r.error || r.stderr || "").trim().slice(0, 300)})`, true);
    }
    const err = asRecord(envelope.error);
    throw new OrcaCommandError(`${label}: ${str(err, "code") ?? "error"} ${str(err, "message") ?? ""}`.trim(), false);
  };

  const status = (): OrcaStatus => {
    try {
      const runtime = asRecord(call(["status"], 10_000).runtime);
      return { reachable: runtime?.reachable === true, appVersion: str(runtime, "appVersion"), state: str(runtime, "state") };
    } catch {
      return { reachable: false, appVersion: null, state: null };
    }
  };

  return {
    status,
    reachable: () => status().reachable,
    listTerminals() {
      return parseTerminalList({ result: call(["terminal", "list", "--limit", "10000"]) });
    },
    listRepos() {
      return parseRepoList({ result: call(["repo", "list"]) });
    },
    listWorktreePaths() {
      const worktrees = call(["worktree", "list", "--limit", "10000"]).worktrees;
      return Array.isArray(worktrees) ? worktrees.flatMap((w) => str(asRecord(w), "path") ?? []) : [];
    },
    addRepo(path) {
      const repo = asRecord(call(["repo", "add", "--path", path]).repo);
      const parsed = parseRepoList({ result: { repos: [repo] } })[0];
      if (!parsed) throw new OrcaCommandError("orca repo add: reply has no repo", true);
      return parsed;
    },
    showExternalWorktrees(repoId) {
      call(["repo", "set", "--repo", `id:${repoId}`, "--external-worktree-visibility", "show"]);
    },
    createTerminal({ worktreePath, title, command }) {
      const t = asRecord(
        call(["terminal", "create", "--worktree", `path:${worktreePath}`, "--title", title, "--command", command])
          .terminal,
      );
      const handle = str(t, "handle");
      if (!handle) throw new OrcaCommandError("orca terminal create: reply has no handle", true);
      return { handle, paneKey: str(t, "paneKey") };
    },
    closeTab(handle) {
      call(["terminal", "close", "--terminal", handle, "--tab"]);
    },
    importWorktree(repoId, path) {
      const launcher = run(["/bin/sh", "-c", `readlink -f "$(command -v ${bin})"`], { timeoutMs: 5_000 }).stdout.trim();
      const app = orcaAppFromLauncher(launcher);
      if (!app) throw new OrcaCommandError(`cannot locate Orca.app from ${launcher || bin}`, false);
      const script = fileURLToPath(new URL("./orca-rpc.cjs", import.meta.url));
      const rpc = (method: string, params: unknown): Record<string, unknown> => {
        const cliDir = `${app}/Contents/Resources/app.asar.unpacked/out/cli`;
        const r = run(["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", `${app}/Contents/MacOS/Orca`, script, cliDir, method, JSON.stringify(params)], {
          timeoutMs: 30_000,
        });
        const envelope = asRecord(parseJson(r.stdout));
        if (envelope?.ok === true) return asRecord(envelope.result) ?? {};
        const err = asRecord(envelope?.error);
        throw new OrcaCommandError(`orca rpc ${method}: ${str(err, "code") ?? "error"} ${str(err, "message") ?? r.stderr.trim()}`.trim(), !envelope);
      };
      const repo = asRecord(rpc("repo.show", { repo: `id:${repoId}` }).repo);
      const current = Array.isArray(repo?.importedExternalWorktreePaths) ? repo.importedExternalWorktreePaths.filter((p): p is string => typeof p === "string") : [];
      if (current.includes(path)) return;
      rpc("repo.update", { repo: `id:${repoId}`, updates: { importedExternalWorktreePaths: [...current, path] } });
    },
    splitTerminal({ handle, direction, command }) {
      const s = asRecord(
        call(["terminal", "split", "--terminal", handle, "--direction", direction, "--command", command]).split,
      );
      const newHandle = str(s, "handle");
      if (!newHandle) throw new OrcaCommandError("orca terminal split: reply has no handle", true);
      const tabId = str(s, "tabId");
      const leafId = str(s, "leafId");
      return { handle: newHandle, paneKey: tabId && leafId ? `${tabId}:${leafId}` : null };
    },
  };
}
