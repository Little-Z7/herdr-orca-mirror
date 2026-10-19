import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Runner } from "./run.ts";

export type GitInfo = { worktreePath: string; repoRoot: string };

export function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isInside(path: string, root: string): boolean {
  const p = canonical(path);
  const r = canonical(root).replace(/\/+$/, "");
  return p === r || p.startsWith(`${r}/`);
}

/** Resolve a directory to its checkout root and main repository root. Null for non-git or bare layouts. */
export function resolveGit(run: Runner, cwd: string): GitInfo | null {
  const r = run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
    timeoutMs: 10_000,
  });
  if (r.status !== 0) return null;
  const [top, common] = r.stdout.trim().split("\n");
  if (!top || !common || basename(common) !== ".git") return null;
  return { worktreePath: canonical(top), repoRoot: canonical(dirname(common)) };
}
