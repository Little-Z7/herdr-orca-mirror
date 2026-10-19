import { Bridge, spawnHerdrStream, type Size } from "./bridge.ts";
import { asRecord, num, parseJson, str, type Runner } from "./run.ts";

export type PaneLookup = { kind: "terminal"; terminalId: string } | { kind: "gone" } | { kind: "unavailable" };

export type AttachLoopDeps = {
  /** Show the terminal until its stream ends; "input_closed" means this Orca pane went away. */
  attach(terminalId: string): Promise<"ended" | "input_closed">;
  paneTerminal(paneId: string): PaneLookup;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(message: string): void;
};

export const RECONNECT_WINDOW_MS = 30_000;
const POLL_MS = 500;
const FAST_EXIT_MS = 1_000;
const MAX_FAST_EXITS = 5;

/**
 * Keep an Orca tab showing one herdr pane. herdr live updates keep pane ids but replace terminal ids, and
 * streams can drop, so after a stream ends we look the pane up again and reconnect (to the new terminal
 * id if it changed). The tab ends when the pane is gone or this Orca pane's input closes.
 */
export async function runAttachLoop(paneId: string, terminalId: string, deps: AttachLoopDeps): Promise<number> {
  let current = terminalId;
  let fastExits = 0;
  for (;;) {
    const started = deps.now();
    if ((await deps.attach(current)) === "input_closed") return 0;
    fastExits = deps.now() - started < FAST_EXIT_MS ? fastExits + 1 : 0;
    if (fastExits >= MAX_FAST_EXITS) {
      deps.log(`orca-mirror: the herdr stream for ${paneId} keeps closing immediately; giving up`);
      return 1;
    }
    const next = await nextTerminal(paneId, deps);
    if (next === null) return 0;
    if (next === "timeout") {
      deps.log(`orca-mirror: herdr did not come back within ${RECONNECT_WINDOW_MS / 1000}s; closing this tab`);
      return 1;
    }
    if (next !== current) deps.log(`orca-mirror: herdr replaced ${current} with ${next} (live update); reattaching ${paneId}`);
    current = next;
  }
}

async function nextTerminal(paneId: string, deps: AttachLoopDeps): Promise<string | null | "timeout"> {
  const deadline = deps.now() + RECONNECT_WINDOW_MS;
  for (;;) {
    const r = deps.paneTerminal(paneId);
    if (r.kind === "gone") return null;
    if (r.kind === "terminal") return r.terminalId;
    if (deps.now() > deadline) return "timeout";
    await deps.sleep(POLL_MS);
  }
}

export function paneTerminalVia(run: Runner, herdrBin: string): (paneId: string) => PaneLookup {
  return (paneId) => {
    const r = run([herdrBin, "pane", "get", paneId], { timeoutMs: 5_000 });
    if (r.status === 0) {
      const terminalId = str(asRecord(asRecord(asRecord(parseJson(r.stdout))?.result)?.pane), "terminal_id");
      return terminalId ? { kind: "terminal", terminalId } : { kind: "unavailable" };
    }
    const code = str(asRecord(asRecord(parseJson(r.stdout) ?? parseJson(r.stderr))?.error), "code");
    return code === "pane_not_found" ? { kind: "gone" } : { kind: "unavailable" };
  };
}

/** herdr's own layout rect for the pane: the size its UI gives the PTY when it controls the tab. */
export function tuiSizeVia(run: Runner, herdrBin: string, paneId: string): () => Size | null {
  return () => {
    const r = run([herdrBin, "pane", "layout", "--pane", paneId], { timeoutMs: 3_000 });
    const layout = asRecord(asRecord(asRecord(parseJson(r.stdout))?.result)?.layout);
    const panes = Array.isArray(layout?.panes) ? layout.panes : [];
    const rect = asRecord(panes.map(asRecord).find((p) => str(p, "pane_id") === paneId)?.rect);
    const cols = num(rect, "width");
    const rows = num(rect, "height");
    return cols && rows ? { cols, rows } : null;
  };
}

export function defaultAttachDeps(run: Runner, herdrBin: string, paneId: string): AttachLoopDeps {
  const log = (message: string) => process.stderr.write(`${message}\r\n`);
  return {
    attach: (terminalId) =>
      new Bridge(terminalId, {
        io: { input: process.stdin, output: process.stdout },
        spawnStream: spawnHerdrStream(herdrBin),
        tuiSize: tuiSizeVia(run, herdrBin, paneId),
        now: Date.now,
        log,
      }).run(),
    paneTerminal: paneTerminalVia(run, herdrBin),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    log,
  };
}
