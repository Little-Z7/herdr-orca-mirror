import { scanAttachProcesses } from "./procscan.ts";
import { loadState, saveState, withLock } from "./state.ts";
import { observe, runSync, type Deps, type SyncReport } from "./sync.ts";

export type UpgradeTarget = { pid: number; terminalId: string; paneId: string | null; handle: string | null; worktreePath: string | null };
export type UpgradeReport = { targets: UpgradeTarget[]; killed: number; sync: SyncReport | null; message: string };

/**
 * Orca tabs that run a plain `herdr terminal attach --takeover` (the legacy plugin's tabs, or ours from
 * before the bridge) own the herdr PTY size and pin it to Orca. Close them (killing only that attach
 * client; the herdr process keeps running) and let sync recreate them with the bridge.
 */
export function runUpgradeTabs(
  deps: Deps & { kill: (pid: number) => void; alive: (pid: number) => boolean; sleep: (ms: number) => void },
  opts: { dryRun: boolean },
): UpgradeReport {
  const targets = withLock(deps.stateDir, (): UpgradeTarget[] => {
    const obs = observe(deps, loadState(deps.stateDir));
    if (!obs) throw new Error("Orca is not running or not reachable");
    const paneOf = new Map(obs.herdr.panes.map((p) => [p.terminalId, p.paneId]));
    const found: UpgradeTarget[] = [];
    for (const a of obs.attach) {
      if (a.paneId !== null || a.inOrca !== true || !paneOf.has(a.terminalId)) continue;
      const orca = obs.orcaTerminals.find((t) => t.paneKey === a.paneKey) ?? null;
      found.push({ pid: a.pid, terminalId: a.terminalId, paneId: paneOf.get(a.terminalId) ?? null, handle: orca?.handle ?? null, worktreePath: orca?.worktreePath ?? null });
    }
    if (opts.dryRun || found.length === 0) return found;
    // Forget them first so the following sync treats them as new instead of "closed by the user", and
    // retire their Orca tabs: Orca may later restore such a tab with a fresh shell, which sync then closes.
    for (const t of found) delete obs.state.terminals[t.terminalId];
    for (const a of obs.attach) {
      const tabId = a.paneKey?.split(":")[0];
      if (tabId && found.some((t) => t.pid === a.pid)) obs.state.retiredTabs[tabId] = { retiredAt: deps.now() };
    }
    saveState(deps.stateDir, obs.state);
    for (const t of found) deps.kill(t.pid);
    return found;
  });
  if (opts.dryRun || targets.length === 0) {
    return { targets, killed: 0, sync: null, message: targets.length ? `would replace ${targets.length} tab(s)` : "no plain-attach Orca tabs found" };
  }
  // Wait for the attach clients and any old-style loop that owned them (it exits on its own) to go away.
  const ids = new Set(targets.map((t) => t.terminalId));
  const panes = new Set(targets.map((t) => t.paneId).filter(Boolean));
  const lingering = () => scanAttachProcesses(deps.run, { stateDir: deps.stateDir }).some((a) => ids.has(a.terminalId) || (a.paneId !== null && panes.has(a.paneId)));
  for (let i = 0; i < 100 && (targets.some((t) => deps.alive(t.pid)) || lingering()); i += 1) deps.sleep(100);
  deps.sleep(500);
  const sync = runSync(deps, { dryRun: false, reason: "upgrade-tabs", startedAt: deps.now(), coalesce: false });
  return { targets, killed: targets.filter((t) => !deps.alive(t.pid)).length, sync, message: `replaced ${sync.created.length} of ${targets.length} tab(s)` };
}
