import { asRecord, num, parseJson, str, type Runner } from "./run.ts";

export type Rect = { x: number; y: number; width: number; height: number };
export type HerdrPane = { paneId: string; terminalId: string; workspaceId: string; tabId: string; cwd: string | null };
export type HerdrTab = { tabId: string; workspaceId: string; label: string | null; number: number | null };
export type HerdrWorktree = { checkoutPath: string; repoRoot: string; isLinked: boolean };
export type HerdrWorkspace = { workspaceId: string; label: string | null; worktree: HerdrWorktree | null };
export type HerdrLayout = { tabId: string; panes: { paneId: string; rect: Rect }[] };
export type HerdrSnapshot = {
  panes: HerdrPane[];
  tabs: HerdrTab[];
  workspaces: HerdrWorkspace[];
  layouts: HerdrLayout[];
  version: string | null;
  protocol: number | null;
};

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((r): r is Record<string, unknown> => r !== null) : [];
}

function parseRect(value: unknown): Rect | null {
  const r = asRecord(value);
  const x = num(r, "x");
  const y = num(r, "y");
  const width = num(r, "width");
  const height = num(r, "height");
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

export function parseHerdrSnapshot(value: unknown): HerdrSnapshot {
  const snapshot = asRecord(asRecord(asRecord(value)?.result)?.snapshot);
  if (!snapshot || !Array.isArray(snapshot.panes)) throw new Error("herdr api snapshot: unexpected response shape");
  const panes: HerdrPane[] = [];
  for (const p of records(snapshot.panes)) {
    const paneId = str(p, "pane_id");
    const terminalId = str(p, "terminal_id");
    const workspaceId = str(p, "workspace_id");
    const tabId = str(p, "tab_id");
    if (paneId && terminalId && workspaceId && tabId) panes.push({ paneId, terminalId, workspaceId, tabId, cwd: str(p, "cwd") });
  }
  const tabs: HerdrTab[] = [];
  for (const t of records(snapshot.tabs)) {
    const tabId = str(t, "tab_id");
    const workspaceId = str(t, "workspace_id");
    if (tabId && workspaceId) tabs.push({ tabId, workspaceId, label: str(t, "label"), number: num(t, "number") });
  }
  const workspaces: HerdrWorkspace[] = [];
  for (const w of records(snapshot.workspaces)) {
    const workspaceId = str(w, "workspace_id");
    if (!workspaceId) continue;
    const wt = asRecord(w.worktree);
    const checkoutPath = str(wt, "checkout_path");
    const repoRoot = str(wt, "repo_root");
    workspaces.push({
      workspaceId,
      label: str(w, "label"),
      worktree: checkoutPath && repoRoot ? { checkoutPath, repoRoot, isLinked: wt?.is_linked_worktree === true } : null,
    });
  }
  const layouts: HerdrLayout[] = [];
  for (const l of records(snapshot.layouts)) {
    const tabId = str(l, "tab_id");
    if (!tabId) continue;
    const layoutPanes: HerdrLayout["panes"] = [];
    for (const p of records(l.panes)) {
      const paneId = str(p, "pane_id");
      const rect = parseRect(p.rect);
      if (paneId && rect) layoutPanes.push({ paneId, rect });
    }
    layouts.push({ tabId, panes: layoutPanes });
  }
  return { panes, tabs, workspaces, layouts, version: str(snapshot, "version"), protocol: num(snapshot, "protocol") };
}

export function readHerdrSnapshot(run: Runner, herdrBin: string): HerdrSnapshot {
  const r = run([herdrBin, "api", "snapshot"], { timeoutMs: 15_000 });
  if (r.status !== 0) throw new Error(`herdr api snapshot failed: ${(r.stderr || r.error || "").trim()}`);
  return parseHerdrSnapshot(parseJson(r.stdout));
}
