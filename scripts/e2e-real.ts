/** Real HTTP → engine → Herdr → PTY → agent receipts, in disposable state. No model calls. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { agentList, herdrResult } from "../src/herdr.ts";
import type { AgentInfo } from "../src/herdr-types.ts";
import { startWebServer } from "../src/web/server.ts";
import { isolatedHerdr } from "./e2e-environment.ts";

const environment = await isolatedHerdr("delivery");
const store = new Store(join(environment.root, "broadcast.sqlite"));
let web: ReturnType<typeof startWebServer> | undefined;
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error(`Timeout: ${what}`);
    await Bun.sleep(100);
  }
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
async function fake(label: string): Promise<AgentInfo> {
  const created = await herdrResult<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(["workspace", "create", "--cwd", environment.root, "--label", label, "--no-focus"]);
  const pane = created.root_pane.pane_id;
  // Shell startup may be asynchronous; wait for a shell before typing a command into it.
  await Bun.sleep(500);
  await herdrResult(["pane", "run", pane, `${quote(process.execPath)} ${quote(join(import.meta.dir, "fake-agent.ts"))} fakebot 4`]);
  let agent: AgentInfo | undefined;
  await until(async () => {
    agent = (await agentList("local")).find(a => a.pane_id === pane && a.agent_status === "idle");
    return !!agent;
  }, `fake agent in ${pane}`);
  return agent!;
}
function receipts(agent: AgentInfo, done = false): string[] {
  const file = join(environment.root, `${agent.pane_id}${done ? ".done" : ""}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function start() {
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
}
async function submit(prompt: string, agents: AgentInfo[]) {
  const base = web!.url.replace(/\/$/, "");
  const response = await fetch(`${base}/api/broadcasts`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ prompt, targets: agents.map(a => ({ machine: "local", pane: a.pane_id, terminal_id: a.terminal_id })) }),
  });
  const result = await response.json() as { id: number };
  assert.equal(response.ok, true, JSON.stringify(result));
  return result.id;
}
try {
  const one = await fake("e2e one"), two = await fake("e2e two");
  start();
  await web!.engine.refreshMachines();
  const page = await fetch(web!.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  const a = await submit("broadcast A", [one, two]);
  await until(() => store.executions(a).every(e => e.state === "sent"), "A submitted to both recipients");
  await until(async () => (await agentList("local")).some(a => a.pane_id === one.pane_id && a.agent_status === "working"), "one working on A");
  const b = await submit("broadcast B", [one]);
  await until(() => store.executions(b)[0]?.state === "sent", "B submitted while one works");
  // Closing the Web service cannot retract a submitted native message.
  await web!.stop(); web = undefined;
  await until(() => receipts(one).length === 2 && receipts(two).length === 1, "both native receipts");
  assert.deepEqual(receipts(one), ["broadcast A", "broadcast B"]);
  assert.deepEqual(receipts(two), ["broadcast A"]);
  await until(() => receipts(one, true).length === 2 && receipts(two, true).length === 1, "native work completes");
  start();
  await web!.engine.refreshMachines();
  for (let i = 0; i < 3; i++) assert.equal((await fetch(web!.url + "api/state")).status, 200);
  await web!.engine.settle();
  await Bun.sleep(500);
  assert.deepEqual(receipts(one), ["broadcast A", "broadcast B"], "restart/refresh must not replay");
  assert.deepEqual(receipts(two), ["broadcast A"], "restart/refresh must not replay");
  assert.ok([...store.executions(a), ...store.executions(b)].every(e => e.state === "sent"), "delivery results stay sent, not task-completed");
  console.log(JSON.stringify({ result: "passed", checks: ["HTTP broadcast to two agents", "submission while working", "native receipt order and counts", "delivery survives Web stop", "restart/refresh never replay", "delivery distinct from work completion"] }, null, 2));
} catch (error) {
  environment.diagnostics(); throw error;
} finally {
  try { await web?.stop(); store.close(); }
  finally { await environment.close(); }
}
