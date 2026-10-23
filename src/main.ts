import { existsSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAttachDeps, runAttachLoop } from "./attach.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { runOpen } from "./open.ts";
import { orcaCli } from "./orca.ts";
import { recordAttachProcess, removeAttachProcess } from "./procscan.ts";
import { defaultRunner } from "./run.ts";
import { installShim } from "./shim.ts";
import { runUpgradeTabs } from "./upgrade.ts";
import { PLUGIN_ID, defaultDirs, formatReport, runSync, stableHerdrBin, type Deps } from "./sync.ts";

const startedAt = Date.now();

const HELP = `orca-mirror — show herdr terminals as tabs in the matching Orca worktree

Usage:
  orca-mirror open [--pane ID | --terminal ID] [--notify] [--json]
  orca-mirror doctor [--json]
  orca-mirror sync [--dry-run] [--json] [--no-coalesce]
  orca-mirror upgrade-tabs [--dry-run]
  orca-mirror install-shim
  orca-mirror help

open      Show the current herdr pane (or --pane/--terminal) in Orca and confirm it attached.
doctor    Versions, what is shown in Orca, what is not and why.
sync      Create Orca tabs for herdr terminals not shown yet (runs from herdr hooks automatically).
upgrade-tabs  Replace Orca tabs running a plain "herdr terminal attach --takeover" (they pin the herdr
              pane size to Orca) with tabs using the size-friendly bridge.
install-shim  Install ~/.local/bin/orca-mirror.
`;

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  const v = i === -1 ? undefined : argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

function socketPath(env: NodeJS.ProcessEnv): string | null {
  const sock = env.HERDR_SOCKET_PATH;
  const defaultSock =
    process.platform === "win32"
      ? join(env.APPDATA || join(homedir(), "AppData/Roaming"), "herdr/herdr.sock")
      : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr/herdr.sock");
  return sock && sock !== defaultSock ? sock : null;
}

function which(name: string): string | null {
  if (process.platform === "win32") {
    const r = defaultRunner(["where.exe", name], { timeoutMs: 5_000 });
    const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const found = lines.find((l) => /\.exe$/i.test(l)) ?? lines[0];
    return r.status === 0 && found ? found : null;
  }
  const r = defaultRunner(["/usr/bin/which", name], { timeoutMs: 5_000 });
  const found = r.stdout.trim();
  return r.status === 0 && found ? found : null;
}

function resolveOrcaBin(env: NodeJS.ProcessEnv): string {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  if (process.platform === "win32") {
    const onPath = which("orca");
    if (onPath) return onPath;
    const candidate = join(env.LOCALAPPDATA || join(homedir(), "AppData/Local"), "Programs/orca/resources/bin/orca.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "orca";
}

function makeDeps(env: NodeJS.ProcessEnv): Deps {
  const dirs = defaultDirs(env);
  return {
    run: defaultRunner,
    orca: orcaCli(defaultRunner, resolveOrcaBin(env)),
    herdrBin: stableHerdrBin(env, which),
    nodeBin: process.execPath,
    mainPath: fileURLToPath(import.meta.url),
    stateDir: dirs.stateDir,
    configDir: dirs.configDir,
    socketPath: socketPath(env),
    now: Date.now,
  };
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function main(argv: string[]): number | Promise<number> {
  const [command = "help", ...rest] = argv;
  const env = process.env;
  const json = rest.includes("--json");
  switch (command) {
    case "attach": {
      const paneId = flagValue(rest, "--pane");
      const terminalId = flagValue(rest, "--terminal");
      if (!paneId || !terminalId) {
        process.stderr.write("usage: orca-mirror attach --pane ID --terminal ID [--herdr PATH]\n");
        return 2;
      }
      const herdrBin = flagValue(rest, "--herdr") ?? env.HERDR_BIN_PATH ?? "herdr";
      const { stateDir } = defaultDirs(env);
      const paneKey = env.ORCA_PANE_KEY ?? null;
      const inOrca = Boolean(paneKey || env.TERM_PROGRAM === "Orca");
      const cleanup = () => removeAttachProcess(stateDir, process.pid);
      process.once("exit", cleanup);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(sig, () => {
          cleanup();
          process.exit(0);
        });
      }
      recordAttachProcess(stateDir, { pid: process.pid, paneId, terminalId, paneKey, inOrca });
      const attachDeps = {
        ...defaultAttachDeps(defaultRunner, herdrBin, paneId),
        onTerminalChange: (next: string) => recordAttachProcess(stateDir, { pid: process.pid, paneId, terminalId: next, paneKey, inOrca }),
      };
      return runAttachLoop(paneId, terminalId, attachDeps).then((code) => {
        cleanup();
        process.exit(code);
      });
    }
    case "sync": {
      const report = runSync(makeDeps(env), {
        dryRun: rest.includes("--dry-run"),
        reason: flagValue(rest, "--reason") ?? env.HERDR_PLUGIN_EVENT ?? "manual",
        startedAt,
        coalesce: !rest.includes("--no-coalesce"),
      });
      process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
      return report.errors.length > 0 || report.failed.length > 0 ? 1 : 0;
    }
    case "open": {
      const deps = makeDeps(env);
      const terminalId = flagValue(rest, "--terminal");
      const paneId = flagValue(rest, "--pane") ?? (terminalId ? null : env.HERDR_PANE_ID ?? null);
      const result = runOpen({ ...deps, sleep }, { paneId, terminalId, timeoutMs: Number(flagValue(rest, "--timeout") ?? 8000), pollMs: 300 });
      const text = `${result.ok ? "ok" : "failed"}: ${result.message}`;
      process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `orca-mirror open ${result.paneId ?? ""}: ${text}\n`);
      if (rest.includes("--notify")) {
        deps.run([deps.herdrBin, "notification", "show", result.ok ? "Orca Mirror" : "Orca Mirror: failed", "--body", result.message], { timeoutMs: 5000 });
      }
      return result.ok ? 0 : 1;
    }
    case "doctor": {
      const deps = makeDeps(env);
      if (rest.includes("--open-pane")) {
        const r = deps.run([deps.herdrBin, "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "doctor"], { timeoutMs: 10_000 });
        if (r.status !== 0) process.stderr.write(r.stderr || r.error || "failed to open doctor pane\n");
        return r.status ?? 1;
      }
      const report = runDoctor(deps);
      process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctor(report));
      if (rest.includes("--pause")) {
        process.stdout.write("\npress Enter to close\n");
        try {
          readSync(0, Buffer.alloc(1));
        } catch {
          /* no tty */
        }
      }
      return report.problems.length > 0 ? 1 : 0;
    }
    case "upgrade-tabs": {
      const r = runUpgradeTabs(
        {
          ...makeDeps(env),
          sleep,
          kill: (pid) => process.kill(pid, "SIGTERM"),
          alive: (pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          },
        },
        { dryRun: rest.includes("--dry-run") },
      );
      if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      else {
        process.stdout.write(`orca-mirror upgrade-tabs${rest.includes("--dry-run") ? " (dry-run)" : ""}: ${r.message}\n`);
        for (const t of r.targets) process.stdout.write(`  ${t.paneId ?? "?"} ${t.terminalId} ${t.worktreePath ?? ""} [${t.handle ?? "?"}]\n`);
        if (r.sync) process.stdout.write(formatReport(r.sync));
      }
      return r.sync && r.sync.created.length < r.targets.length ? 1 : 0;
    }
    case "install-shim": {
      const r = installShim({ home: homedir(), nodeBin: process.execPath, mainPath: fileURLToPath(import.meta.url), pathEnv: env.PATH ?? "" });
      process.stdout.write(`${r.message}\n`);
      return r.ok ? 0 : 1;
    }
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`orca-mirror: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
