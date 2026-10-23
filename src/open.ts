import { loadConfig } from "./config.ts";
import { planCreates } from "./reconcile.ts";
import { loadState, saveState, withLock } from "./state.ts";
import { anchorsOf, ensureRepos, executeCreate, observe, resolveTargets, type Deps, type Observation } from "./sync.ts";

export type OpenOptions = { paneId: string | null; terminalId: string | null; timeoutMs: number; pollMs: number };
export type OpenResult = {
  ok: boolean;
  message: string;
  paneId?: string;
  terminalId?: string;
  handle?: string | null;
  worktreePath?: string | null;
  created: boolean;
};

const REASON_TEXT: Record<string, string> = {
  no_cwd: "herdr reports no cwd for this pane",
  not_git: "the pane's directory is not inside a git checkout, so there is no Orca worktree for it",
  repo_not_in_orca: "the repo is not registered in Orca and auto_add_repo is off",
  repo_add_failed: "orca repo add failed recently",
};

function describe(obs: Observation, terminalId: string): { handle: string | null; worktreePath: string | null; title: string | null } {
  const s = obs.statuses.get(terminalId);
  const orca = s?.kind === "paired" ? s.orca : null;
  return { handle: orca?.handle ?? null, worktreePath: orca?.worktreePath ?? null, title: orca?.title ?? null };
}

/**
 * Show one herdr terminal in Orca on request. Unlike the automatic sync this ignores include_paths and a
 * previous close, and it reports success only after the attach is seen running inside an Orca pane.
 */
export function runOpen(deps: Deps & { sleep: (ms: number) => void }, opts: OpenOptions): OpenResult {
  const { config, errors } = loadConfig(deps.configDir);
  if (errors.length > 0) return { ok: false, created: false, message: `config.toml is invalid: ${errors.join("; ")}` };

  const first = withLock(deps.stateDir, (): OpenResult | { waitFor: { paneId: string; terminalId: string; handle: string | null } } => {
    const obs = observe(deps, loadState(deps.stateDir));
    if (!obs) return { ok: false, created: false, message: "Orca is not running or not reachable (check `orca status`)" };
    const pane = obs.herdr.panes.find((p) => (opts.paneId ? p.paneId === opts.paneId : p.terminalId === opts.terminalId));
    if (!pane) {
      return { ok: false, created: false, message: `herdr has no pane ${opts.paneId ?? opts.terminalId ?? "(none given)"}; run this inside a herdr pane or pass --pane/--terminal` };
    }
    const base = { paneId: pane.paneId, terminalId: pane.terminalId };
    const status = obs.statuses.get(pane.terminalId);
    saveState(deps.stateDir, obs.state);
    if (status?.kind === "paired") {
      const d = describe(obs, pane.terminalId);
      return { ok: true, created: false, ...base, ...d, message: `already shown in Orca${d.worktreePath ? ` under ${d.worktreePath}` : ""}${d.title ? ` ("${d.title}")` : ""}${d.handle ? ` [${d.handle}]` : ""}` };
    }
    if (status?.kind === "pending") return { waitFor: { ...base, handle: obs.state.terminals[pane.terminalId]?.handle ?? null } };

    const repos = deps.orca.listRepos();
    const resolved = resolveTargets(deps, obs.herdr, [pane], [], repos);
    const why = resolved.skipped.get(pane.terminalId);
    if (why) return { ok: false, created: false, ...base, message: `cannot open in Orca: ${REASON_TEXT[why] ?? why}` };
    const notes = { notes: [] as string[], errors: [] as string[] };
    const ensured = ensureRepos(deps, resolved.targets, repos, config, obs.state, notes, false);
    const blocked = ensured.skipped.get(pane.terminalId);
    if (blocked) return { ok: false, created: false, ...base, message: `cannot open in Orca: ${REASON_TEXT[blocked] ?? blocked} ${notes.errors.join("; ")}`.trim() };
    const { anchors, handles } = anchorsOf(obs);
    const [op] = planCreates(ensured.ready, obs.herdr, anchors, { mirrorSplits: config.mirrorSplits });
    if (!op) return { ok: false, created: false, ...base, message: "nothing to create (internal planning error)" };
    const r = executeCreate(deps, op, obs.state, handles, "manual");
    saveState(deps.stateDir, obs.state);
    if (!r.ok) {
      return { ok: false, created: false, ...base, message: `Orca refused to create the tab: ${r.error}${r.ambiguous ? " (Orca may still have created it; check before retrying)" : ""}` };
    }
    return { waitFor: { ...base, handle: r.handle } };
  });
  if ("ok" in first) return first;

  const { paneId, terminalId, handle } = first.waitFor;
  const deadline = deps.now() + opts.timeoutMs;
  for (;;) {
    const obs = observe(deps, loadState(deps.stateDir));
    if (obs?.statuses.get(terminalId)?.kind === "paired") {
      withLock(deps.stateDir, () => {
        const fresh = observe(deps, loadState(deps.stateDir));
        if (fresh) saveState(deps.stateDir, fresh.state);
      });
      const d = describe(obs, terminalId);
      return { ok: true, created: true, paneId, terminalId, ...d, message: `opened in Orca${d.worktreePath ? ` under ${d.worktreePath}` : ""}${d.handle ? ` [${d.handle}]` : ""}` };
    }
    if (deps.now() >= deadline) {
      const tabAlive = Boolean(handle && obs?.orcaTerminals.some((t) => t.handle === handle));
      return {
        ok: false,
        created: true,
        paneId,
        terminalId,
        handle,
        message: tabAlive
          ? `Orca created tab ${handle}, but no herdr attach showed up in it within ${opts.timeoutMs / 1000}s`
          : `Orca created tab ${handle ?? "(unknown)"}, but it exited right away; the herdr attach probably failed (run \`orca-mirror doctor\`)`,
      };
    }
    deps.sleep(opts.pollMs);
  }
}
