import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { Bridge } from "../src/bridge.ts";

type FakeStream = { args: string[]; commands: Record<string, unknown>[]; stdout: PassThrough; killed: boolean; child: ChildProcess };

function harness(opts: { tui?: { cols: number; rows: number } | null } = {}) {
  const input = new PassThrough();
  const written: Buffer[] = [];
  const output = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        written.push(Buffer.from(chunk));
        cb();
      },
    }),
    { columns: 100, rows: 30 },
  );
  const streams: FakeStream[] = [];
  const spawnStream = (args: string[]): ChildProcess => {
    const stdout = new PassThrough();
    const commands: Record<string, unknown>[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        for (const line of String(chunk).split("\n").filter(Boolean)) commands.push(JSON.parse(line));
        cb();
      },
    });
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      kill: () => {
        s.killed = true;
        return true;
      },
    }) as unknown as ChildProcess;
    const s: FakeStream = { args, commands, stdout, killed: false, child };
    streams.push(s);
    return child;
  };
  const bridge = new Bridge("term_a", {
    io: { input, output },
    spawnStream,
    tuiSize: () => (opts.tui === undefined ? { cols: 173, rows: 55 } : opts.tui),
    now: () => 0,
    log: () => {},
  });
  const frame = (s: FakeStream, text: string, full = false) =>
    s.stdout.write(`${JSON.stringify({ type: "terminal.frame", bytes: Buffer.from(text).toString("base64"), full })}\n`);
  const closed = (s: FakeStream, reason: string) => s.stdout.write(`${JSON.stringify({ type: "terminal.closed", reason })}\n`);
  return { bridge, input, output, written, streams, frame, closed };
}

const tick = () => new Promise((r) => setImmediate(r));
const last = (h: ReturnType<typeof harness>) => h.streams[h.streams.length - 1]!;

test("starts read-only at the Orca pane's size, enables focus reports, and forwards frames", async () => {
  const h = harness();
  void h.bridge.run();
  assert.deepEqual(h.streams[0]?.args, ["terminal", "session", "observe", "term_a", "--cols", "100", "--rows", "30"]);
  h.frame(h.streams[0]!, "hello");
  await tick();
  const out = Buffer.concat(h.written).toString();
  assert.ok(out.startsWith("\x1b[?1004h"));
  assert.ok(out.includes("hello"));
  assert.equal(h.bridge.mode, "observe");
});

test("typing takes control at our size (takeover) and forwards the bytes", async () => {
  const h = harness();
  void h.bridge.run();
  h.input.write("ls\r");
  await tick();
  const control = last(h);
  assert.deepEqual(control.args, ["terminal", "session", "control", "term_a", "--cols", "100", "--rows", "30", "--takeover"]);
  assert.deepEqual(control.commands, [{ type: "terminal.input", bytes: Buffer.from("ls\r").toString("base64") }]);
  h.frame(h.streams[0]!, "stale observe frame");
  await tick();
  assert.ok(!Buffer.concat(h.written).toString().includes("stale observe frame"));
});

test("focus in claims; focus out hands herdr's layout size back, releases, and observes again", async () => {
  const h = harness();
  void h.bridge.run();
  h.input.write("\x1b[I");
  await tick();
  const control = last(h);
  assert.equal(h.bridge.mode, "control");
  assert.deepEqual(control.commands, []);
  h.input.write("\x1b[O");
  await tick();
  assert.deepEqual(control.commands, [
    { type: "terminal.resize", cols: 173, rows: 55 },
    { type: "terminal.release" },
  ]);
  assert.equal(h.bridge.mode, "observe");
  assert.equal(last(h).args[2], "observe");
});

test("focus events reach the app only when it enabled focus reporting", async () => {
  const h = harness();
  void h.bridge.run();
  h.input.write("\x1b[I");
  await tick();
  h.frame(last(h), "\x1b[?1004h");
  await tick();
  h.input.write("\x1b[Ox");
  await tick();
  // focus-out was forwarded before release; then "x" claims control again and is typed.
  const sent = h.streams.flatMap((s) => s.commands);
  assert.deepEqual(sent[0], { type: "terminal.input", bytes: Buffer.from("\x1b[O").toString("base64") });
  assert.deepEqual(sent.at(-1), { type: "terminal.input", bytes: Buffer.from("x").toString("base64") });
});

test("losing control to another client falls back to read-only instead of ending", async () => {
  const h = harness();
  void h.bridge.run();
  h.input.write("a");
  await tick();
  h.closed(last(h), "terminal attach taken over");
  await tick();
  assert.equal(h.bridge.mode, "observe");
});

test("a resize of the Orca pane (e.g. Orca iOS opening it) takes control at the new size; later resizes follow", async () => {
  const h = harness();
  void h.bridge.run();
  h.output.columns = 80;
  h.output.emit("resize");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(last(h).args, ["terminal", "session", "control", "term_a", "--cols", "80", "--rows", "30", "--takeover"]);
  h.output.rows = 20;
  h.output.emit("resize");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(last(h).commands.at(-1), { type: "terminal.resize", cols: 80, rows: 20 });
});

test("the stream closing ends the session; the Orca pane's input closing reports input_closed", async () => {
  const h = harness();
  const ended = h.bridge.run();
  h.closed(h.streams[0]!, "terminal exited");
  assert.equal(await ended, "ended");

  const h2 = harness();
  const gone = h2.bridge.run();
  h2.input.end();
  assert.equal(await gone, "input_closed");
});
