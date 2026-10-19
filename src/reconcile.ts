import type { HerdrPane, HerdrSnapshot, Rect } from "./herdr.ts";
import type { OrcaTerminal, SplitDirection } from "./orca.ts";
import type { AttachProcess } from "./procscan.ts";
import type { Entry, State } from "./state.ts";

export const PENDING_GRACE_MS = 30_000;
export const RETRY_AFTER_MS = 60_000;
export const MAX_FAILURES = 3;

export type Status =
  | { kind: "paired"; orca: OrcaTerminal | null }
  | { kind: "pending" }
  | { kind: "unconfirmed" }
  | { kind: "closed" }
  | { kind: "failed" }
  | { kind: "retry_wait" }
  | { kind: "candidate" };

/**
 * Decide per herdr terminal whether it is already shown in Orca. A live attach process is the source of
 * truth; the state file only prevents a second automatic create for terminals we already handled.
 */
export function classify(input: {
  panes: HerdrPane[];
  orcaTerminals: OrcaTerminal[];
  attach: AttachProcess[];
  state: State;
  now: number;
}): Map<string, Status> {
  const byPaneKey = new Map(input.orcaTerminals.filter((t) => t.paneKey).map((t) => [t.paneKey, t]));
  const out = new Map<string, Status>();
  for (const pane of input.panes) {
    const id = pane.terminalId;
    if (out.has(id)) continue;
    // An attach loop for this pane counts even while it reattaches after a herdr live update.
    const shown = input.attach.filter(
      (p) => (p.terminalId === id || (p.paneId !== null && p.paneId === pane.paneId)) && p.inOrca !== false,
    );
    if (shown.length > 0) {
      const orca = shown.map((p) => (p.paneKey ? byPaneKey.get(p.paneKey) : undefined)).find(Boolean) ?? null;
      out.set(id, { kind: "paired", orca });
      continue;
    }
    out.set(id, statusFromEntry(input.state.terminals[id], input.now, byPaneKey));
  }
  return out;
}

function statusFromEntry(entry: Entry | undefined, now: number, orcaPanes: Map<string | null, OrcaTerminal>): Status {
  if (!entry) return { kind: "candidate" };
  switch (entry.status) {
    case "creating":
    case "created":
      // Orca lists a created pane immediately, so a known pane key missing from the list means it was closed.
      if (entry.paneKey && !orcaPanes.has(entry.paneKey)) return { kind: "closed" };
      return now - (entry.createdAt ?? 0) < PENDING_GRACE_MS ? { kind: "pending" } : { kind: "unconfirmed" };
    case "paired":
      return { kind: "closed" };
    case "failed":
      if ((entry.failures ?? 0) >= MAX_FAILURES) return { kind: "failed" };
      return now - (entry.lastFailedAt ?? 0) < RETRY_AFTER_MS ? { kind: "retry_wait" } : { kind: "candidate" };
  }
}

/**
 * Record live pairings and drop entries whose herdr terminal no longer exists (terminal ids are never
 * reused; a herdr live update hands every pane a new one). Own-pane records live as long as the Orca pane.
 */
export function nextState(
  state: State,
  panes: HerdrPane[],
  statuses: Map<string, Status>,
  orcaTerminals: OrcaTerminal[],
  now: number,
): State {
  const alive = new Set(panes.map((p) => p.terminalId));
  const paneOf = new Map(panes.map((p) => [p.terminalId, p.paneId]));
  const terminals: Record<string, Entry> = {};
  for (const [id, entry] of Object.entries(state.terminals)) if (alive.has(id)) terminals[id] = entry;
  for (const [id, status] of statuses) {
    if (status.kind !== "paired") continue;
    const prev = terminals[id];
    terminals[id] = {
      ...prev,
      status: "paired",
      herdrPaneId: paneOf.get(id) ?? prev?.herdrPaneId,
      method: prev?.method ?? "existing",
      handle: status.orca?.handle ?? prev?.handle ?? null,
      paneKey: status.orca?.paneKey ?? prev?.paneKey ?? null,
      worktreePath: status.orca?.worktreePath ?? prev?.worktreePath,
      pairedAt: prev?.pairedAt ?? now,
    };
  }
  const orcaKeys = new Set(orcaTerminals.map((t) => t.paneKey));
  const ownPanes: State["ownPanes"] = {};
  for (const [key, own] of Object.entries(state.ownPanes ?? {})) if (orcaKeys.has(key)) ownPanes[key] = own;
  return { ...state, terminals, ownPanes };
}

export type Target = { pane: HerdrPane; worktreePath: string; repoRoot: string };
export type CreateOp = {
  terminalId: string;
  paneId: string;
  worktreePath: string;
  repoRoot: string;
  title: string;
  split: { anchorTerminalId: string; direction: SplitDirection } | null;
};

const EDGE_TOLERANCE = 2;

/** How `b` sits next to `a`: side by side (horizontal split) or stacked (vertical split). */
export function adjacency(a: Rect, b: Rect): { direction: SplitDirection; overlap: number } | null {
  const vOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const hOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const sideBySide = Math.abs(a.x + a.width - b.x) <= EDGE_TOLERANCE || Math.abs(b.x + b.width - a.x) <= EDGE_TOLERANCE;
  const stacked = Math.abs(a.y + a.height - b.y) <= EDGE_TOLERANCE || Math.abs(b.y + b.height - a.y) <= EDGE_TOLERANCE;
  if (vOverlap > 0 && sideBySide) return { direction: "horizontal", overlap: vOverlap };
  if (hOverlap > 0 && stacked) return { direction: "vertical", overlap: hOverlap };
  return null;
}

export function tabTitle(snapshot: HerdrSnapshot, pane: HerdrPane): string {
  const ws = snapshot.workspaces.find((w) => w.workspaceId === pane.workspaceId);
  const tab = snapshot.tabs.find((t) => t.tabId === pane.tabId);
  return `${ws?.label ?? pane.workspaceId} · ${tab?.label ?? tab?.number ?? pane.tabId}`;
}

/**
 * Order creates so a herdr tab's first pane opens an Orca tab and its other panes split next to an
 * already-mirrored neighbour. `anchors` maps already-shown terminals to their Orca worktree path.
 */
export function planCreates(
  targets: Target[],
  snapshot: HerdrSnapshot,
  anchors: Map<string, { worktreePath: string | null; orphaned: boolean }>,
  opts: { mirrorSplits: boolean },
): CreateOp[] {
  const wsOrder = new Map(snapshot.workspaces.map((w, i) => [w.workspaceId, i]));
  const tabOrder = new Map(snapshot.tabs.map((t, i) => [t.tabId, i]));
  const rectOf = new Map<string, Rect>();
  for (const layout of snapshot.layouts) for (const p of layout.panes) rectOf.set(p.paneId, p.rect);
  const terminalOfPane = new Map(snapshot.panes.map((p) => [p.paneId, p.terminalId]));

  const sorted = [...targets].sort((a, b) => {
    const ka = [wsOrder.get(a.pane.workspaceId) ?? 1e9, tabOrder.get(a.pane.tabId) ?? 1e9, rectOf.get(a.pane.paneId)?.y ?? 0, rectOf.get(a.pane.paneId)?.x ?? 0];
    const kb = [wsOrder.get(b.pane.workspaceId) ?? 1e9, tabOrder.get(b.pane.tabId) ?? 1e9, rectOf.get(b.pane.paneId)?.y ?? 0, rectOf.get(b.pane.paneId)?.x ?? 0];
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return (ka[i] ?? 0) - (kb[i] ?? 0);
    return 0;
  });

  const usable = new Map<string, string | null>();
  for (const [id, a] of anchors) if (!a.orphaned) usable.set(id, a.worktreePath);
  const ops: CreateOp[] = [];
  for (const t of sorted) {
    let split: CreateOp["split"] = null;
    const rect = rectOf.get(t.pane.paneId);
    const layout = snapshot.layouts.find((l) => l.tabId === t.pane.tabId);
    if (opts.mirrorSplits && rect && layout) {
      let best: { id: string; direction: SplitDirection; overlap: number } | null = null;
      for (const sibling of layout.panes) {
        const id = terminalOfPane.get(sibling.paneId);
        if (!id || sibling.paneId === t.pane.paneId || !usable.has(id)) continue;
        if (usable.get(id) !== t.worktreePath) continue;
        const adj = adjacency(sibling.rect, rect);
        if (adj && (!best || adj.overlap > best.overlap)) best = { id, ...adj };
      }
      if (best) split = { anchorTerminalId: best.id, direction: best.direction };
    }
    ops.push({
      terminalId: t.pane.terminalId,
      paneId: t.pane.paneId,
      worktreePath: t.worktreePath,
      repoRoot: t.repoRoot,
      title: tabTitle(snapshot, t.pane),
      split,
    });
    usable.set(t.pane.terminalId, t.worktreePath);
  }
  return ops;
}

const PROMPT_END = /[%$#>❯]\s*$/;

/**
 * Retired tabs (replaced by upgrade-tabs) that Orca brought back with a fresh shell: close them, but only
 * when nothing shows herdr in them, no agent runs there, and the screen (if Orca has one) ends at a prompt.
 */
export function retiredToClose(orcaTerminals: OrcaTerminal[], attach: AttachProcess[], retired: Record<string, unknown>): OrcaTerminal[] {
  const prefixes = Object.keys(retired);
  if (prefixes.length === 0) return [];
  const attachedKeys = new Set(attach.map((a) => a.paneKey).filter(Boolean));
  return orcaTerminals.filter((t) => {
    const tabId = t.paneKey?.split(":")[0];
    if (!tabId || !prefixes.some((p) => tabId.startsWith(p))) return false;
    if (attachedKeys.has(t.paneKey) || t.agentIdentity) return false;
    const screen = (t.preview ?? "").trimEnd();
    return screen === "" || PROMPT_END.test(screen);
  });
}

export type WorktreeRef = { worktreePath: string; repoRoot: string };
export type VisibilityAction = { kind: "show_external" | "import"; repoId: string; repoPath: string; worktreePath: string };

/**
 * What it takes to make every herdr workspace's worktree appear in Orca's sidebar: register missing repos,
 * show external worktrees per repo (public CLI), or show one worktree that a per-source policy hides.
 */
export function visibilityActions(
  worktrees: WorktreeRef[],
  visible: Set<string>,
  repos: { id: string; path: string; externalWorktreeVisibility: string | null }[],
): { actions: VisibilityAction[]; missingRepos: string[] } {
  const actions: VisibilityAction[] = [];
  const missingRepos = new Set<string>();
  const shownRepos = new Set<string>();
  const seen = new Set<string>();
  for (const wt of worktrees) {
    if (visible.has(wt.worktreePath) || seen.has(wt.worktreePath)) continue;
    seen.add(wt.worktreePath);
    const repo = repos.find((r) => r.path === wt.repoRoot);
    if (!repo) {
      missingRepos.add(wt.repoRoot);
      continue;
    }
    if (wt.worktreePath === wt.repoRoot) continue;
    const external = !hiddenBySource(wt.worktreePath, wt.repoRoot) && repo.externalWorktreeVisibility !== "show";
    if (external && !shownRepos.has(repo.id)) {
      shownRepos.add(repo.id);
      actions.push({ kind: "show_external", repoId: repo.id, repoPath: repo.path, worktreePath: wt.worktreePath });
    } else if (!external) {
      actions.push({ kind: "import", repoId: repo.id, repoPath: repo.path, worktreePath: wt.worktreePath });
    }
  }
  return { actions, missingRepos: [...missingRepos] };
}

/** Orca hides worktrees under these per-checkout folders by a separate per-source policy the CLI cannot change. */
export function hiddenBySource(worktreePath: string, repoRoot: string): string | null {
  const root = repoRoot.replace(/\/+$/, "");
  if (worktreePath.startsWith(`${root}/.claude/worktrees/`)) return "claude";
  if (worktreePath.startsWith(`${root}/.gsd-workspaces/`)) return "gsd";
  return null;
}
