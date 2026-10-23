import { spawn, type ChildProcess } from "node:child_process";
import { asRecord, parseJson, str } from "./run.ts";

export type Size = { cols: number; rows: number };
export type BridgeResult = "ended" | "input_closed";

export type BridgeIO = {
  input: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
  output: NodeJS.WritableStream & { columns?: number; rows?: number };
};

export type BridgeDeps = {
  io: BridgeIO;
  /** Start `herdr terminal session observe|control ...` with piped stdio. */
  spawnStream: (args: string[]) => ChildProcess;
  /** The size herdr's own UI lays this pane out at, handed back when Orca lets go. */
  tuiSize: () => Size | null;
  now: () => number;
  log: (message: string) => void;
};

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
/** Without focus reports (older Orca/xterm), give the size back after this long without typing. */
export const IDLE_RELEASE_MS = 120_000;

type Stream = { kind: "observe" | "control"; child: ChildProcess; stale: boolean };

/**
 * Show one herdr terminal in this (Orca) terminal without fighting herdr's own UI over the PTY size.
 * herdr gives a terminal's size to its single controller, so we only observe (read-only, renders at our
 * size, never resizes the PTY) until the user focuses or types in this Orca pane; then we take control
 * at our size. On blur we resize the PTY back to herdr's layout for the pane and release control.
 */
export class Bridge {
  private stream: Stream | null = null;
  private focusSeen = false;
  private appWantsFocus = false;
  private lastInputAt = 0;
  private resizeTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private done: ((r: BridgeResult) => void) | null = null;
  private readonly onData = (chunk: Buffer | string) => this.handleInput(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "binary"));
  private readonly onEnd = () => this.finish("input_closed");
  private readonly onResize = () => {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.handleResize(), 100);
  };

  private readonly terminalId: string;
  private readonly deps: BridgeDeps;

  constructor(terminalId: string, deps: BridgeDeps) {
    this.terminalId = terminalId;
    this.deps = deps;
  }

  get mode(): "observe" | "control" | null {
    return this.stream?.kind ?? null;
  }

  run(): Promise<BridgeResult> {
    return new Promise((resolve) => {
      this.done = resolve;
      const { input, output } = this.deps.io;
      if (input.isTTY && input.setRawMode) input.setRawMode(true);
      input.on("data", this.onData);
      input.on("end", this.onEnd);
      input.on("close", this.onEnd);
      input.resume();
      output.on("resize", this.onResize);
      output.write(ENABLE_FOCUS_REPORTING);
      this.idleTimer = setInterval(() => this.checkIdle(), 5_000);
      this.idleTimer.unref();
      this.open("observe");
    });
  }

  private size(): Size {
    const { columns, rows } = this.deps.io.output;
    return { cols: columns && columns > 0 ? columns : 120, rows: rows && rows > 0 ? rows : 40 };
  }

  private open(kind: "observe" | "control"): void {
    const { cols, rows } = this.size();
    const args = ["terminal", "session", kind, this.terminalId, "--cols", String(cols), "--rows", String(rows)];
    if (kind === "control") args.push("--takeover");
    const child = this.deps.spawnStream(args);
    const stream: Stream = { kind, child, stale: false };
    if (this.stream) this.retire(this.stream);
    this.stream = stream;
    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.handleRecord(stream, line);
      }
    });
    child.on("exit", () => this.handleClosed(stream, "stream exited"));
    child.on("error", (e) => this.handleClosed(stream, `stream error: ${e.message}`));
  }

  private retire(stream: Stream): void {
    stream.stale = true;
    stream.child.stdin?.end();
    setTimeout(() => stream.child.kill(), 500).unref?.();
  }

  private handleRecord(stream: Stream, line: string): void {
    if (stream.stale) return;
    const rec = asRecord(parseJson(line));
    if (rec?.type === "terminal.frame") {
      const bytes = Buffer.from(str(rec, "bytes") ?? "", "base64");
      const text = bytes.toString("binary");
      if (text.includes("\x1b[?1004h")) this.appWantsFocus = true;
      if (text.includes("\x1b[?1004l")) this.appWantsFocus = false;
      this.deps.io.output.write(bytes);
      if (rec.full === true) this.deps.io.output.write(ENABLE_FOCUS_REPORTING);
    } else if (rec?.type === "terminal.closed") {
      this.handleClosed(stream, str(rec, "reason") ?? "closed");
    }
  }

  private handleClosed(stream: Stream, reason: string): void {
    if (stream.stale || stream !== this.stream) return;
    stream.stale = true;
    if (stream.kind === "control" && /taken over/.test(reason)) {
      // Another client (herdr attach elsewhere, a duplicate tab) took control: keep showing, read-only.
      this.open("observe");
      return;
    }
    this.deps.log(`orca-mirror: ${stream.kind} stream for ${this.terminalId} closed (${reason})`);
    this.finish("ended");
  }

  private send(command: Record<string, unknown>): void {
    if (this.stream?.kind === "control" && !this.stream.stale) this.stream.child.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  private claim(): void {
    if (this.stream?.kind !== "control") this.open("control");
  }

  private release(): void {
    if (this.stream?.kind !== "control") return;
    const tui = this.deps.tuiSize();
    if (tui) this.send({ type: "terminal.resize", cols: tui.cols, rows: tui.rows });
    this.send({ type: "terminal.release" });
    this.open("observe");
  }

  private handleInput(chunk: Buffer): void {
    let text = chunk.toString("binary");
    const events: ("in" | "out")[] = [];
    text = text.replace(/\x1b\[(I|O)/g, (seq) => {
      events.push(seq === FOCUS_IN ? "in" : "out");
      return "";
    });
    for (const e of events) {
      this.focusSeen = true;
      if (e === "in") {
        this.claim();
        if (this.appWantsFocus) this.send({ type: "terminal.input", bytes: Buffer.from(FOCUS_IN).toString("base64") });
      } else {
        if (this.appWantsFocus) this.send({ type: "terminal.input", bytes: Buffer.from(FOCUS_OUT).toString("base64") });
        this.release();
      }
    }
    if (text.length === 0) return;
    this.lastInputAt = this.deps.now();
    this.claim();
    this.send({ type: "terminal.input", bytes: Buffer.from(text, "binary").toString("base64") });
  }

  /**
   * A resize of this Orca pane means someone is looking at it here (e.g. Orca's iOS app opened it), so take
   * the size like herdr does for its own clients: the most recently active viewer wins. herdr hands the
   * size back to its own UI as soon as the user interacts there.
   */
  private handleResize(): void {
    if (this.stream?.kind === "control") this.send({ type: "terminal.resize", ...this.size() });
    else this.open("control");
  }

  private checkIdle(): void {
    if (!this.focusSeen && this.stream?.kind === "control" && this.deps.now() - this.lastInputAt > IDLE_RELEASE_MS) this.release();
  }

  private finish(result: BridgeResult): void {
    if (!this.done) return;
    const resolve = this.done;
    this.done = null;
    const { input, output } = this.deps.io;
    input.off("data", this.onData);
    input.off("end", this.onEnd);
    input.off("close", this.onEnd);
    input.pause();
    output.off("resize", this.onResize);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.stream) this.retire(this.stream);
    this.stream = null;
    resolve(result);
  }
}

export function spawnHerdrStream(herdrBin: string): (args: string[]) => ChildProcess {
  return (args) => spawn(herdrBin, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
}
