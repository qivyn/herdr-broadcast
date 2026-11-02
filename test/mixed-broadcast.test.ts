import { afterEach, beforeEach, expect, test } from "bun:test";
import { Store } from "../src/db.ts";
import { snapshot, startWebServer } from "../src/web/server.ts";
import { FakeHerdr, until } from "./helpers.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let fake: FakeHerdr, store: Store, web: ReturnType<typeof startWebServer>, base: string;
beforeEach(async () => {
  fake = new FakeHerdr(); store = new Store(fake.dbFile);
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] }, { tickMs: 30, identityWaitMs: 20 });
  base = web.url.replace(/\/$/, ""); await web.engine.refreshMachines();
});
afterEach(async () => { await web?.stop(); store?.close(); fake?.cleanup(); });
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};

test("new broadcasts reject existing targets without creating history or sending", async () => {
  const a = fake.addAgent("local", "pi", "idle"); await web.engine.refresh("local");
  const r = await post("/api/broadcasts", { prompt: "no", targets: [{ machine: "local", pane: a.pane_id, terminal_id: a.terminal_id }] });
  expect(r.status).toBe(400); expect(store.listBroadcasts()).toEqual([]); expect(fake.server().prompts).toEqual([]);
});

test("custom startup requires confirmation, cannot replay commands, and confirms once", async () => {
  const command = "offline-fixture --private-option=never-persist";
  const r = await post("/api/broadcasts", { prompt: "custom first", new: [{ machine: "local", kind: "custom", cwd: fake.dir, command, label: "Custom" }] });
  expect(r.status).toBe(200); const id = r.body.execution_ids[0];
  await until(() => !!store.execution(id)?.terminal_id && web.engine.customStartupPending(id));
  const e = store.execution(id)!;
  await until(() => !!fake.server().processes?.[e.pane_id!]?.length);
  await Bun.sleep(300);
  expect(fake.server().prompts).toEqual([]);
  expect(snapshot(store, web.engine).broadcasts[0]!.executions[0]).toMatchObject({ custom_startup_pending: true });
  expect(JSON.stringify(store.executions(e.broadcast_id))).not.toContain(command);
  expect((await post(`/api/executions/${id}/confirm-startup`, { terminal_id: "stale" })).status).toBe(400);
  const confirm = () => post(`/api/executions/${id}/confirm-startup`, { terminal_id: e.terminal_id });
  expect((await Promise.all([confirm(), confirm()])).map(r => r.status)).toEqual([200, 200]);
  await until(() => store.execution(id)?.state === "sent");
  expect((await confirm()).status).toBe(200);
  expect(fake.server().prompts.map(p => p.text)).toEqual(["custom first"]);
  expect(JSON.stringify(store.db.query("SELECT * FROM continuations").all())).not.toContain(command);
  const next = await post(`/api/broadcasts/${e.broadcast_id}/follow-up`, { prompt: "custom second", targets: [{ execution_id: id, terminal_id: e.terminal_id }] });
  expect(next.status).toBe(200);
  await until(() => fake.server().prompts.length === 2);
  expect(fake.server().prompts.map(p => p.text)).toEqual(["custom first", "custom second"]);
  expect(fake.calls().filter(c => c.includes('["pane","run"'))).toHaveLength(1);
});

for (const action of ["cancel", "replace", "replace-terminal", "stop", "timeout"] as const) test(`custom startup ${action} never sends or replays`, async () => {
  if (action === "timeout") {
    await web.stop(); web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] }, { tickMs: 30, startupConfirmMs: 300 });
    base = web.url.replace(/\/$/, ""); await web.engine.refreshMachines();
  }
  const r = await post("/api/broadcasts", { prompt: "never replay", new: [{ machine: "local", kind: "custom", cwd: fake.dir, command: "offline-fixture" }] });
  const id = r.body.execution_ids[0];
  await until(() => !!store.execution(id)?.terminal_id && web.engine.customStartupPending(id));
  const e = store.execution(id)!;
  await until(() => !!fake.server().processes?.[e.pane_id!]?.length);
  if (action === "cancel") web.engine.cancelStartup(id);
  if (action === "replace") { await Bun.sleep(300); fake.mutate(s => { s.servers.local!.processes![e.pane_id!] = []; }); }
  if (action === "replace-terminal") fake.mutate(s => { s.servers.local!.panes.find(p => p.pane_id === e.pane_id)!.terminal_id = "replacement-terminal"; });
  if (action === "stop") await web.stop();
  await until(() => ["failed", "cancelled"].includes(store.execution(id)!.state));
  expect(fake.server().prompts).toEqual([]);
  if (action === "stop") {
    web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
    base = web.url.replace(/\/$/, ""); await web.engine.refreshMachines();
  }
  expect((await post(`/api/executions/${id}/confirm-startup`, { terminal_id: e.terminal_id })).status).toBe(400);
  await web.engine.refresh("local"); expect(fake.server().prompts).toEqual([]);
  expect(fake.calls().filter(c => c.includes('["pane","run"'))).toHaveLength(1);
});

for (const action of ["pause-resume", "stop", "cancel"] as const) test(`custom creation ${action} cannot execute a command after its startup wait ends`, async () => {
  await web.stop();
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] }, { tickMs: 30, startupConfirmMs: 300 });
  base = web.url.replace(/\/$/, ""); await web.engine.refreshMachines();
  let created = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const engine = web.engine as any;
  const placeFor = engine.placeFor.bind(engine);
  engine.placeFor = async (...args: any[]) => { const result = await placeFor(...args); created = true; await gate; return result; };
  try {
    const response = await post("/api/broadcasts", { prompt: "never send", new: [{ machine: "local", kind: "custom", cwd: fake.dir, command: "must-not-launch" }] });
    expect(response.status).toBe(200); const id = response.body.execution_ids[0];
    await until(() => created);
    if (action === "pause-resume") { web.engine.pause(); web.engine.resume(); }
    else if (action === "stop") web.engine.stop();
    else expect(web.engine.cancelStartup(id)).toBe(true);
    release(); await web.engine.settle();
    expect(fake.calls().filter(call => call.includes('["pane","run"'))).toEqual([]);
    expect(fake.server().prompts).toEqual([]);
    expect(store.execution(id)?.state).toBe(action === "cancel" ? "cancelled" : "failed");
    expect(web.engine.customStartupPending(id)).toBe(false);
    expect((await post(`/api/executions/${id}/confirm-startup`, { terminal_id: store.execution(id)?.terminal_id })).status).toBe(400);
  } finally { release(); }
});

test("an invalid mixed selection or custom command creates no partial round or starts", async () => {
  const id = store.createBroadcast({ title: "history", prompt: "old", executions: [] });
  for (const body of [
    { new: [{ machine: "local", kind: "pi", cwd: fake.dir }], targets: [{ execution_id: 999, terminal_id: "x" }] },
    { new: [{ machine: "local", kind: "pi", cwd: fake.dir }, { machine: "local", kind: "custom", cwd: fake.dir, command: "" }] },
    { new: [{ machine: "local", kind: "pi", cwd: fake.dir, count: 1.5 }] },
  ]) expect((await post(`/api/broadcasts/${id}/follow-up`, { prompt: "no", ...body })).status).toBe(400);
  expect(store.rounds(id)).toHaveLength(1); expect(fake.server().panes).toEqual([]); expect(fake.server().prompts).toEqual([]);
});

test("real CLI creates, follows up, confirms custom startup, lists rounds and rejects old --to", async () => {
  const config = join(fake.dir, "cli-config"); mkdirSync(config);
  writeFileSync(join(config, "config.toml"), `web_port = ${new URL(base).port}\n`);
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), ...args], {
      env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: fake.dir, HERDR_SOCKET_PATH: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, error };
  };
  expect((await cli("send", "--prompt", "old", "--to", "w1:p1")).code).toBe(1);
  expect(store.listBroadcasts()).toEqual([]);
  const custom = JSON.stringify({ cwd: fake.dir, command: "offline-cli", label: "CLI Agent" });
  const created = await cli("send", "--prompt", "first CLI", "--custom", custom);
  expect(created.code).toBe(0); expect(created.out).toContain("round 1"); expect(created.out).toContain("execution IDs:");
  const id = store.listBroadcasts()[0]!.id;
  await until(() => !!store.executions(id)[0]?.terminal_id && !!fake.server().processes?.[store.executions(id)[0]!.pane_id!]?.length);
  await Bun.sleep(300);
  const e = store.executions(id)[0]!;
  expect((await cli("confirm-startup", "--execution", String(e.id), "--terminal-id", e.terminal_id!)).code).toBe(0);
  await until(() => store.execution(e.id)?.state === "sent");
  const followed = await cli("follow-up", "--broadcast", String(id), "--execution", String(e.id), "--prompt", "second CLI", "--new", `pi@${fake.dir}`);
  expect(followed.code).toBe(0); expect(followed.out).toContain("round 2");
  await until(() => store.executions(id).every(e => e.state === "sent"));
  expect(store.listBroadcasts()).toHaveLength(1);
  expect(fake.server().prompts.filter(p => p.pane_id === e.pane_id).map(p => p.text)).toEqual(["first CLI", "second CLI"]);
  const listed = await cli("list"); expect(listed.code).toBe(0); expect(listed.out).toContain("round 1"); expect(listed.out).toContain("round 2");
  const other = store.createBroadcast({ title: "other", prompt: "old", executions: [{ machine_id: "local", machine_label: "Local", target_kind: "existing" }] });
  expect((await cli("follow-up", "--broadcast", String(other), "--execution", String(e.id), "--prompt", "no cross task")).code).toBe(1);
  expect(store.rounds(other)).toHaveLength(1);
});

test("A B then B plus new C delivers only the current round and retains A B history", async () => {
  const first = await post("/api/broadcasts", { prompt: "first", new: [{ machine: "local", kind: "pi", cwd: fake.dir, count: 2 }] });
  expect(first.status).toBe(200); const id = first.body.id;
  await until(() => store.executions(id).every(e => e.state === "sent"));
  const original = store.executions(id); const b = original[1]!;
  // Fake integrations do not report a native identity by default; explicitly confirm this live process.
  await post(`/api/executions/${b.id}/confirm-session`, { terminal_id: b.terminal_id });
  const next = await post(`/api/broadcasts/${id}/follow-up`, { prompt: "second", targets: [{ execution_id: b.id, terminal_id: b.terminal_id }], new: [{ machine: "local", kind: "pi", cwd: fake.dir }] });
  expect(next.status).toBe(200); expect(next.body.executions).toBe(2); expect(next.body.execution_ids).toHaveLength(2);
  await until(() => store.executions(id).filter(e => e.round_id === next.body.round_id).every(e => e.state === "sent"));
  expect(store.listBroadcasts()).toHaveLength(1); expect(store.rounds(id)).toHaveLength(2);
  expect(store.executions(id).slice(0, 2)).toEqual(original);
  const c = store.executions(id).find(e => e.round_id === next.body.round_id && e.target_kind === "new")!;
  expect(fake.server().prompts.filter(p => p.pane_id === original[0]!.pane_id).map(p => p.text)).toEqual(["first"]);
  expect(fake.server().prompts.filter(p => p.pane_id === b.pane_id).map(p => p.text)).toEqual(["first", "second"]);
  expect(fake.server().prompts.filter(p => p.pane_id === c.pane_id).map(p => p.text)).toEqual(["second"]);
  expect(c.slot).toBeGreaterThan(b.slot); expect(c.workspace_id).toBe(b.workspace_id);
});
