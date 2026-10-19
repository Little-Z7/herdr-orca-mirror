import type { Runner } from "./run.ts";

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

const ATTACH_RE = /(?:^|\/)herdr terminal attach (term_[A-Za-z0-9]+)(?:\s|$)/;
const LOOP_RE = /\/src\/main\.ts attach --pane (\S+) --terminal (term_[A-Za-z0-9]+)(?:\s|$)/;

export function parseAttachCandidates(psOutput: string): { pid: number; terminalId: string; paneId: string | null }[] {
  const out: { pid: number; terminalId: string; paneId: string | null }[] = [];
  for (const line of psOutput.split("\n")) {
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
  for (const line of psEnvOutput.split("\n")) {
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

export function scanAttachProcesses(run: Runner): AttachProcess[] {
  const listed = run(["ps", "-axww", "-o", "pid=,command="], { timeoutMs: 10_000 });
  if (listed.status !== 0) throw new Error(`ps failed: ${(listed.stderr || listed.error || "").trim()}`);
  const candidates = parseAttachCandidates(listed.stdout);
  if (candidates.length === 0) return [];
  const withEnv = run(["ps", "-ww", "-E", "-o", "pid=,command=", "-p", candidates.map((c) => c.pid).join(",")], {
    timeoutMs: 10_000,
  });
  const env = parseEnvLines(withEnv.stdout);
  return candidates.map((c) => {
    const e = env.get(c.pid);
    return { ...c, paneKey: e?.paneKey ?? null, inOrca: e ? e.inOrca : null };
  });
}
