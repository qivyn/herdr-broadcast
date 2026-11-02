/** Real HTTP → engine → Herdr → PTY receipts; fresh custom agents and mixed rounds, no models. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store, type Execution } from "../src/db.ts";
import { agentList } from "../src/herdr.ts";
import { shellQuote } from "../src/machine-command.ts";
import { startWebServer } from "../src/web/server.ts";
import { isolatedHerdr } from "./e2e-environment.ts";

const environment = await isolatedHerdr("delivery");
const store = new Store(join(environment.root, "broadcast.sqlite"));
let web: ReturnType<typeof startWebServer> | undefined;
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() >= end) throw new Error(`Timeout: ${what}`); await Bun.sleep(100); }
}
function receipts(e: Execution, done = false): string[] {
  const file = join(environment.root, `${e.pane_id}${done ? ".done" : ""}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function start() { web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] }); }
async function post(path: string, body: unknown) {
  const base = web!.url.replace(/\/$/, "");
  const r = await fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await r.json() as any;
  assert.equal(r.ok, true, JSON.stringify(result)); return result;
}
const fresh = (count: number) => [{ machine: "local", kind: "custom", cwd: environment.root, count, label: "Offline Agent",
  command: `${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dir, "fake-agent.ts"))} fakebot 4` }];
async function confirm(e: Execution) {
  await until(async () => (await agentList("local")).some(a => a.pane_id === e.pane_id && a.agent_status === "idle"), "fake ready");
  // Agent reports precede the startup observer's process checks. Synchronize with that
  // observer instead of assuming it finishes within 400 ms on a shared CI runner.
  await until(() => {
    const current = store.execution(e.id)!;
    assert.equal(current.state, "starting", JSON.stringify(current));
    return !!(web!.engine as any).customWaits.get(e.id)?.processes;
  }, "startup observer captured the foreground process");
  assert.deepEqual(receipts(e), []);
  await post(`/api/executions/${e.id}/confirm-startup`, { terminal_id: e.terminal_id });
}
try {
  start(); await web!.engine.refreshMachines();
  assert.equal((await fetch(web!.url)).status, 200);
  const first = await post("/api/broadcasts", { prompt: "broadcast A", new: fresh(2) });
  await until(() => store.executions(first.id).every(e => !!e.terminal_id), "fresh terminals");
  const [one, two] = store.executions(first.id) as [Execution, Execution];
  await confirm(one); await confirm(two);
  await until(() => store.executions(first.id).every(e => e.state === "sent"), "first round sent");
  await until(async () => (await agentList("local")).some(a => a.pane_id === one.pane_id && a.agent_status === "working"), "one working");
  const original = store.executions(first.id);
  const next = await post(`/api/broadcasts/${first.id}/follow-up`, { prompt: "broadcast B", targets: [{ execution_id: one.id, terminal_id: one.terminal_id }], new: fresh(1) });
  await until(() => store.executions(first.id).some(e => e.round_id === next.round_id && e.target_kind === "new" && !!e.terminal_id), "third terminal");
  const three = store.executions(first.id).find(e => e.round_id === next.round_id && e.target_kind === "new")!;
  await confirm(three);
  await until(() => store.executions(first.id).every(e => e.state === "sent"), "mixed round sent");
  assert.equal(store.listBroadcasts().length, 1); assert.equal(store.rounds(first.id).length, 2);
  assert.deepEqual(store.executions(first.id).slice(0, 2), original);
  assert.equal(three.workspace_id, one.workspace_id); assert.ok(three.slot > two.slot);
  await web!.stop(); web = undefined;
  await until(() => receipts(one).length === 2 && receipts(two).length === 1 && receipts(three).length === 1, "receipt counts");
  assert.deepEqual(receipts(one), ["broadcast A", "broadcast B"]);
  assert.deepEqual(receipts(two), ["broadcast A"]); assert.deepEqual(receipts(three), ["broadcast B"]);
  await until(() => receipts(one, true).length === 2, "work complete");
  start(); await web!.engine.refreshMachines();
  for (let i = 0; i < 3; i++) assert.equal((await fetch(web!.url + "api/state")).status, 200);
  await web!.engine.settle(); await Bun.sleep(500);
  assert.deepEqual(receipts(one), ["broadcast A", "broadcast B"]);
  assert.deepEqual(receipts(two), ["broadcast A"]); assert.deepEqual(receipts(three), ["broadcast B"]);
  assert.ok(store.executions(first.id).every(e => e.state === "sent"));
  // Hold a real Herdr-created terminal before the creation response reaches the startup waiter.
  // Cancelling/draining at this boundary must prevent the command itself, not just its prompt.
  for (const action of ["cancel", "drain"] as const) {
    const engine = web!.engine as any;
    const placeFor = engine.placeFor;
    let created = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const marker = join(environment.root, `must-not-launch-${action}`);
    engine.placeFor = async (...args: any[]) => { const result = await placeFor.apply(engine, args); created = true; await gate; return result; };
    try {
      const request = await post("/api/broadcasts", { prompt: "never deliver after creation ended", new: [{ ...fresh(1)[0],
        command: `printf launched > ${shellQuote(marker)}; ${fresh(1)[0]!.command}` }] });
      const execution = store.executions(request.id)[0]!;
      await until(() => created, "gated real terminal creation");
      if (action === "cancel") await post(`/api/executions/${execution.id}/cancel`, {});
      else { web!.engine.pause(); web!.engine.resume(); }
      release();
      await until(() => ["failed", "cancelled"].includes(store.execution(execution.id)!.state), "creation stopped without launching");
      const stopped = store.execution(execution.id)!;
      assert.equal(stopped.state, action === "cancel" ? "cancelled" : "failed");
      assert.ok(stopped.terminal_id, "the newly created terminal remains inspectable");
      assert.equal(existsSync(marker), false, "startup command must never have executed");
      assert.deepEqual(receipts(stopped), [], "no prompt reaches the fake Agent");
      await web!.engine.refresh("local");
      assert.equal(existsSync(marker), false, "refresh never replays an ended launch");
    } finally { release(); engine.placeFor = placeFor; }
  }
  console.log(JSON.stringify({ result: "passed", checks: ["new custom terminals", "zero prompts before confirmation", "mixed rounds", "one task", "receipt counts and order", "same workspace", "busy submission", "restart never replays", "cancel/drain during terminal creation never executes commands"] }));
} catch (error) { environment.diagnostics(); throw error; }
finally { try { await web?.stop(); store.close(); } finally { await environment.close(); } }
