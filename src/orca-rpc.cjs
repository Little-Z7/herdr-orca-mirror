// Calls one Orca runtime RPC method through Orca's own bundled client. Run with Orca's Electron binary in
// node mode: ELECTRON_RUN_AS_NODE=1 <Orca.app>/Contents/MacOS/Orca orca-rpc.cjs <cliDir> <method> <paramsJson>
// Used only for settings the public `orca` CLI does not expose (per-worktree sidebar visibility).
const [, , cliDir, method, paramsJson] = process.argv;
const { RuntimeClient } = require(`${cliDir}/runtime-client.js`);
new RuntimeClient()
  .call(method, JSON.parse(paramsJson))
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  })
  .catch((error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: error?.code ?? "rpc_failed", message: String(error?.message ?? error) } }));
    process.exit(1);
  });
