import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  enabled: boolean;
  /** Only repos/worktrees under these paths are mirrored. Empty means everything. */
  includePaths: string[];
  autoAddRepo: boolean;
  ensureExternalVisibility: boolean;
  mirrorSplits: boolean;
  /** Make every herdr workspace's worktree visible in Orca's sidebar (including per-source hidden ones). */
  mirrorSidebar: boolean;
};

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  includePaths: [],
  autoAddRepo: true,
  ensureExternalVisibility: true,
  mirrorSplits: true,
  mirrorSidebar: true,
};

const BOOL_KEYS = {
  enabled: "enabled",
  auto_add_repo: "autoAddRepo",
  ensure_external_visibility: "ensureExternalVisibility",
  mirror_splits: "mirrorSplits",
  mirror_sidebar: "mirrorSidebar",
} as const;

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function parseStringArray(raw: string): string[] | null {
  if (!raw.startsWith("[") || !raw.endsWith("]")) return null;
  const body = raw.slice(1, -1);
  const quoted = /"((?:[^"\\]|\\.)*)"/g;
  if (body.replace(quoted, "").replace(/[\s,]/g, "") !== "") return null;
  return [...body.matchAll(quoted)].map((m) => expandHome(JSON.parse(`"${m[1] ?? ""}"`) as string));
}

/** Minimal TOML subset: `key = true|false` and `key = ["a", "b"]`; section headers and comments are ignored. */
export function parseConfig(text: string | null): { config: Config; errors: string[] } {
  const config: Config = { ...DEFAULT_CONFIG, includePaths: [] };
  const errors: string[] = [];
  for (const [i, rawLine] of (text ?? "").split("\n").entries()) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const m = line.match(/^([a-z_]+)\s*=\s*(.+)$/);
    if (!m?.[1] || m[2] === undefined) {
      errors.push(`line ${i + 1}: cannot parse "${rawLine.trim()}"`);
      continue;
    }
    const [, key, value] = m;
    if (key in BOOL_KEYS) {
      if (value !== "true" && value !== "false") errors.push(`line ${i + 1}: ${key} must be true or false`);
      else config[BOOL_KEYS[key as keyof typeof BOOL_KEYS]] = value === "true";
    } else if (key === "include_paths") {
      const paths = parseStringArray(value);
      if (!paths) errors.push(`line ${i + 1}: include_paths must be an array of strings`);
      else config.includePaths = paths;
    } else {
      errors.push(`line ${i + 1}: unknown key ${key}`);
    }
  }
  return { config, errors };
}

/** A broken config disables syncing instead of falling back to "mirror everything". */
export function loadConfig(configDir: string): { config: Config; errors: string[] } {
  let text: string | null = null;
  try {
    text = readFileSync(join(configDir, "config.toml"), "utf8");
  } catch {
    text = null;
  }
  const parsed = parseConfig(text);
  return parsed.errors.length > 0 ? { config: { ...parsed.config, enabled: false }, errors: parsed.errors } : parsed;
}
