import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asRecord, defaultRunner, num, parseJson, str, type Runner } from "./run.ts";

/**
 * A process that shows a herdr terminal: either the `herdr terminal attach <terminal_id>` leaf or our
 * `main.ts attach --pane <pane_id> --terminal <terminal_id>` loop, which survives herdr live handoffs
 * (they keep pane ids but replace terminal ids). Orca injects ORCA_PANE_KEY (= tabId:leafId) into every
 * PTY it spawns, so the environment names the Orca pane. `inOrca` is null when the environment could not
 * be read; callers must treat that as "displayed".
 */
export type AttachProcess = {
  pid: number;
  terminalId: string;
  paneId: string | null;
  paneKey: string | null;
  inOrca: boolean | null;
};

const ATTACH_RE = /(?:^|[/\\])herdr(?:\.exe)?["']?\s+terminal\s+attach\s+(term_[A-Za-z0-9]+)(?:\s|$)/;
const LOOP_RE = /[/\\]src[/\\]main\.ts["']?\s+attach\s+--pane\s+(\S+)\s+--terminal\s+(term_[A-Za-z0-9]+)(?:\s|$)/;

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function recordAttachProcess(stateDir: string, proc: AttachProcess): void {
  const dir = join(stateDir, "attach");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${proc.pid}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(proc)}\n`);
  renameSync(tmp, file);
}

export function removeAttachProcess(stateDir: string, pid: number): void {
  try {
    unlinkSync(join(stateDir, "attach", `${pid}.json`));
  } catch {
    /* already gone */
  }
}

export function readRecordedAttachProcesses(stateDir: string, alive: (pid: number) => boolean = defaultAlive): AttachProcess[] {
  const dir = join(stateDir, "attach");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: AttachProcess[] = [];
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const rec = asRecord(parseJson(readFileSync(path, "utf8")));
      const pid = num(rec, "pid");
      const terminalId = str(rec, "terminalId");
      if (!pid || !terminalId) continue;
      if (!alive(pid)) {
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
        continue;
      }
      out.push({
        pid,
        terminalId,
        paneId: str(rec, "paneId"),
        paneKey: str(rec, "paneKey"),
        inOrca: typeof rec?.inOrca === "boolean" ? rec.inOrca : null,
      });
    } catch {
      /* ignore partial or removed file */
    }
  }
  return out;
}

export function parseAttachCandidates(psOutput: string): { pid: number; terminalId: string; paneId: string | null }[] {
  const out: { pid: number; terminalId: string; paneId: string | null }[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m?.[1] || m[2] === undefined) continue;
    const loop = m[2].match(LOOP_RE);
    const attach = m[2].match(ATTACH_RE);
    if (loop?.[1] && loop[2]) out.push({ pid: Number(m[1]), terminalId: loop[2], paneId: loop[1] });
    else if (attach?.[1]) out.push({ pid: Number(m[1]), terminalId: attach[1], paneId: null });
  }
  return out;
}

export function parseEnvLines(psEnvOutput: string): Map<number, { paneKey: string | null; inOrca: boolean | null }> {
  const out = new Map<number, { paneKey: string | null; inOrca: boolean | null }>();
  for (const line of psEnvOutput.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m?.[1] || m[2] === undefined) continue;
    const text = m[2];
    const paneKey = text.match(/(?:^|\s)ORCA_PANE_KEY=([0-9A-Za-z-]+:[0-9A-Za-z-]+)(?:\s|$)/)?.[1] ?? null;
    const termProgram = text.match(/(?:^|\s)TERM_PROGRAM=(\S+)/)?.[1] ?? null;
    const envReadable = /(?:^|\s)(PATH|HOME|USER)=/.test(text);
    out.set(Number(m[1]), {
      paneKey,
      inOrca: paneKey || termProgram === "Orca" ? true : envReadable ? false : null,
    });
  }
  return out;
}

export function scanAttachProcesses(
  run: Runner,
  opts?: { stateDir?: string; platform?: NodeJS.Platform; alive?: (pid: number) => boolean },
): AttachProcess[] {
  const recorded = opts?.stateDir ? readRecordedAttachProcesses(opts.stateDir, opts.alive) : [];
  const platform = opts?.platform ?? process.platform;
  if (platform === "win32" && run === defaultRunner) return recorded;

  const listed = run(["ps", "-axww", "-o", "pid=,command="], { timeoutMs: 10_000 });
  if (listed.status !== 0) throw new Error(`ps failed: ${(listed.stderr || listed.error || "").trim()}`);
  const candidates = parseAttachCandidates(listed.stdout);
  if (candidates.length === 0) return recorded;
  const withEnv = run(["ps", "-ww", "-E", "-o", "pid=,command=", "-p", candidates.map((c) => c.pid).join(",")], {
    timeoutMs: 10_000,
  });
  const env = parseEnvLines(withEnv.stdout);
  const byPid = new Map<number, AttachProcess>(recorded.map((r) => [r.pid, r]));
  for (const c of candidates) {
    if (byPid.has(c.pid)) continue;
    const e = env.get(c.pid);
    byPid.set(c.pid, { ...c, paneKey: e?.paneKey ?? null, inOrca: e ? e.inOrca : null });
  }
  return [...byPid.values()];
}
