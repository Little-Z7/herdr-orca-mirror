import { spawnSync } from "node:child_process";

export type RunResult = { status: number | null; stdout: string; stderr: string; error?: string };
export type Runner = (argv: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => RunResult;

export const defaultRunner: Runner = (argv, opts = {}) => {
  const [cmd, ...args] = argv;
  if (!cmd) return { status: null, stdout: "", stderr: "", error: "empty argv" };
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message };
};

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function str(rec: Record<string, unknown> | null, key: string): string | null {
  const value = rec?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function num(rec: Record<string, unknown> | null, key: string): number | null {
  const value = rec?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
