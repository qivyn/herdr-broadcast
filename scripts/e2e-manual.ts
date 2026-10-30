/** Real unrecognized process → manual binding → serialized paste, in an isolated Herdr. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { herdrResult, paneList } from "../src/herdr.ts";
import { shellQuote } from "../src/machine-command.ts";
import { terminalProcesses } from "../src/manual-session.ts";
import { startWebServer } from "../src/web/server.ts";
import { isolatedHerdr } from "./e2e-environment.ts";

const env = await isolatedHerdr("manual");
const store = new Store(join(env.root, "broadcast.sqlite"));
let web: ReturnType<typeof startWebServer> | undefined;
const file = join(env.root, "unrecognized.ts"), receipts = join(env.root, "receipts.jsonl");
writeFileSync(file, `import { appendFileSync } from 'node:fs';\nconsole.log('manual fixture ready');\nfor await(const line of console) appendFileSync(process.argv[2], JSON.stringify(line)+'\\n');\n`);
const received = () => existsSync(receipts) ? readFileSync(receipts, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
async function until(fn: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!await fn()) { if (Date.now() > deadline) throw new Error(`timeout: ${label}`); await Bun.sleep(100); }
}
async function request(path: string, body: unknown) {
  const base = web!.url.replace(/\/$/, "");
  const r = await fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, body: await r.json() as any };
}
async function runFixture(pane: string, terminal: string) {
  await Bun.sleep(300);
  await herdrResult(["pane", "run", pane, `${shellQuote(process.execPath)} ${shellQuote(file)} ${shellQuote(receipts)}`]);
  await until(async () => { try { return (await terminalProcesses("local", pane, terminal)).length > 0; } catch { return false; } }, "foreground process identity");
}
try {
  const created = await herdrResult<any>(["workspace", "create", "--cwd", env.root, "--label", "manual fixture", "--no-focus"]);
  const pane = created.root_pane;
  await runFixture(pane.pane_id, pane.terminal_id);
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
  await web.engine.refreshMachines();
  const target = { machine: "local", pane: pane.pane_id, terminal_id: pane.terminal_id, manual: true };
  assert.equal((await request("/api/machines/local/manual-binding", target)).ok, true);
  const sent = await request("/api/broadcasts", { prompt: "manual first", targets: [target] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const id = sent.body.id;
  await until(() => store.executions(id)[0]?.state === "sent", "first delivery");
  const e = store.executions(id)[0]!;
  assert.equal(e.session_value, null);
  assert.equal((await request(`/api/broadcasts/${id}/follow-up`, { prompt: "manual followup", targets: [{ execution_id: e.id, terminal_id: e.terminal_id }] })).ok, true);
  await until(() => received().length === 2, "two receipts");
  assert.deepEqual(received(), ["manual first", "manual followup"]);
  await herdrResult(["pane", "send-keys", pane.pane_id, "ctrl+c"]);
  await until(async () => { try { await terminalProcesses("local", pane.pane_id, pane.terminal_id); return false; } catch { return true; } }, "process exited");
  assert.equal((await request(`/api/broadcasts/${id}/follow-up`, { prompt: "must not hit shell", targets: [{ execution_id: e.id, terminal_id: e.terminal_id }] })).ok, false);
  await herdrResult(["workspace", "close", created.workspace.workspace_id]);
  assert.equal((await request(`/api/executions/${e.id}/continue`, {})).ok, true);
  const binding = store.continuation(`execution:${e.id}`)!;
  assert.ok((await paneList("local")).some(p => p.terminal_id === binding.terminal_id));
  assert.deepEqual(received(), ["manual first", "manual followup"]);
  await runFixture(binding.pane_id, binding.terminal_id);
  assert.equal((await request(`/api/executions/${e.id}/confirm-session`, { terminal_id: binding.terminal_id })).ok, true);
  assert.equal((await request(`/api/broadcasts/${id}/follow-up`, { prompt: "after explicit restore", targets: [{ execution_id: e.id, terminal_id: binding.terminal_id }] })).ok, true);
  await until(() => received().length === 3, "restored process receipt");
  assert.deepEqual(received(), ["manual first", "manual followup", "after explicit restore"]);
  console.log(JSON.stringify({ result: "passed", checks: ["unrecognized process", "manual binding", "round inheritance", "exit to shell blocked", "explicit restore", "no history replay"] }));
} catch (error) { env.diagnostics(); throw error; }
finally { await web?.stop(); store.close(); await env.close(); }
