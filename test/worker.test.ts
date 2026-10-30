import { expect, test } from "bun:test";
import { runHook } from "../src/worker.ts";
import { Store } from "../src/db.ts";
import { startWebServer } from "../src/web/server.ts";
import { Engine } from "../src/engine.ts";
import { FakeHerdr, until } from "./helpers.ts";

const options = { host: "127.0.0.1", port: 0, token: null, hosts: [] };
const timing = { tickMs: 20, localPollMs: 40, remotePollMs: 40, launchPollMs: 30 };
const target = (a: ReturnType<FakeHerdr["addAgent"]>, machine = "local") => ({ machine_id: machine, machine_label: machine, target_kind: "existing" as const, agent_kind: a.agent, pane_id: a.pane_id, terminal_id: a.terminal_id });
const post = (base: string, path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });

test("obsolete event hooks and snapshots never dispatch history", async () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile), engine = new Engine(store, () => {}, timing);
  try {
    store.createBroadcast({ title: "a", prompt: "hello", executions: [target(fake.addAgent("local", "claude"))] });
    expect(await runHook(store, "pane.agent_status_changed", "{}")).toContain("ignored");
    await engine.refresh("local"); expect(fake.server().prompts).toEqual([]);
    engine.start(); const unwatch = engine.watch("local"); await Bun.sleep(100); unwatch(); await engine.settle();
    expect(fake.server().prompts).toEqual([]);
  } finally { engine.stop(); await engine.settle(); store.close(); fake.cleanup(); }
});

for (const machine of ["local", "remote"]) test(`HTTP sends immediately to a busy ${machine} agent without browser subscriptions`, async () => {
  const fake = new FakeHerdr(); if (machine !== "local") fake.addMachine(machine, "Remote");
  const store = new Store(fake.dbFile), a = fake.addAgent(machine, "claude", "working"), web = startWebServer(store, options, timing);
  try {
    await web.engine.refreshMachines();
    const r = await post(web.url, "api/broadcasts", { prompt: "now", targets: [{ machine, pane: a.pane_id, terminal_id: a.terminal_id }] });
    expect(r.ok).toBe(true); const result = await r.json() as any;
    await until(() => store.executions(result.id)[0]!.state === "sent");
    expect(fake.server(machine).prompts).toEqual([{ pane_id: a.pane_id, text: "now" }]);
    expect(fake.server(machine).agents[0]!.agent_status).toBe("working");
  } finally { await web.stop(); store.close(); fake.cleanup(); }
});

test("restart preserves delivery history and never sends an old queued or interrupted request", async () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile); let web = startWebServer(store, options, timing);
  try {
    const r = await post(web.url, "api/broadcasts", { prompt: "first", new: [{ machine: "local", kind: "claude", cwd: "/tmp", count: 1 }] });
    expect(r.ok).toBe(true); const { id } = await r.json() as any;
    await until(() => store.executions(id)[0]!.state === "sent");
    const sent = store.executions(id)[0]!;
    await web.stop();
    const old = store.createRound(id, "never replay", [{ ...sent, target_kind: "existing" }]);
    const legacy = store.executions(id).find(e => e.round_id === old.id)!; store.update(legacy.id, { state: "queued" });
    web = startWebServer(store, options, timing);
    await web.engine.refresh("local"); await web.engine.settle();
    expect(store.execution(legacy.id)!.state).toBe("cancelled");
    expect(store.execution(sent.id)!.state).toBe("sent");
    expect(fake.server().prompts.map(p => p.text)).toEqual(["first"]);
  } finally { await web.stop(); store.close(); fake.cleanup(); }
});

test("drain timeout restores acceptance while already accepted input completes", async () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile), a = fake.addAgent("local", "claude", "working");
  fake.mutate(s => { s.servers.local!.promptDelayMs = 300; });
  const web = startWebServer(store, options, timing);
  try {
    const r = await post(web.url, "api/broadcasts", { prompt: "slow", targets: [{ machine: "local", pane: a.pane_id, terminal_id: a.terminal_id }] });
    expect(r.ok).toBe(true);
    expect(await web.drain(20)).toBe(false); expect(web.engine.dispatching).toBe(true);
    expect(await web.drain()).toBe(true); expect(web.engine.dispatching).toBe(false);
    expect(fake.server().prompts.map(p => p.text)).toEqual(["slow"]);
    expect(fake.server().agents[0]!.agent_status).toBe("working");
    expect((await post(web.url, "api/broadcasts", {})).status).toBe(503);
    web.resume(); expect(web.engine.dispatching).toBe(true);
  } finally { await web.stop(); store.close(); fake.cleanup(); }
});

test("closing browser streams leaves an accepted send running; snapshots and refreshes never replay it", async () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile), a = fake.addAgent("local", "claude", "working");
  fake.mutate(s => { s.servers.local!.promptDelayMs = 300; });
  const web = startWebServer(store, options, timing), streams = [new AbortController(), new AbortController()];
  try {
    for (const c of streams) { const r = await fetch(web.url + "api/events", { signal: c.signal }); await r.body!.getReader().read(); }
    const r = await post(web.url, "api/broadcasts", { prompt: "after close", targets: [{ machine: "local", pane: a.pane_id, terminal_id: a.terminal_id }] });
    expect(r.ok).toBe(true); streams.forEach(c => c.abort());
    const { id } = await r.json() as any;
    await until(() => store.executions(id)[0]?.state === "sent");
    expect(web.engine.identityPending(store.executions(id)[0]!.id)).toBe(true);
    await Promise.all(Array.from({ length: 8 }, () => fetch(web.url + "api/state")));
    expect(fake.server().prompts).toEqual([{ pane_id: a.pane_id, text: "after close" }]);
  } finally { streams.forEach(c => c.abort()); await web.stop(); store.close(); fake.cleanup(); }
});

test("a pause during HTTP validation rejects the request without creating deferred history", async () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile), a = fake.addAgent("local", "claude");
  const web = startWebServer(store, options, timing), refresh = web.engine.refresh.bind(web.engine);
  try {
    web.engine.refresh = async id => { await refresh(id); web.engine.pause(); };
    const r = await post(web.url, "api/broadcasts", { prompt: "never", targets: [{ machine: "local", pane: a.pane_id, terminal_id: a.terminal_id }] });
    expect(r.status).toBe(503); expect(store.listBroadcasts()).toEqual([]); expect(fake.server().prompts).toEqual([]);
  } finally { await web.stop(); store.close(); fake.cleanup(); }
});

test("draining during agent creation completes that accepted send before shutdown", async () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile);
  fake.mutate(s => { s.servers.local!.startDelayMs = 300; });
  const web = startWebServer(store, options, timing);
  try {
    const r = await post(web.url, "api/broadcasts", { prompt: "after launch", new: [{ machine: "local", kind: "claude", cwd: "/tmp", count: 1 }] });
    expect(r.ok).toBe(true); const { id } = await r.json() as any;
    expect(store.executions(id)[0]!.state).toBe("starting");
    expect(await web.drain()).toBe(true);
    expect(store.executions(id)[0]!.state).toBe("sent");
    expect(fake.server().prompts.map(p => p.text)).toEqual(["after launch"]);
    expect(web.engine.dispatching).toBe(false);
  } finally { await web.stop(); store.close(); fake.cleanup(); }
});

for (const action of ["cancel", "drain"]) test(`${action} ends an HTTP startup-confirmation wait without closing the agent or replaying input`, async () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile);
  process.env.FAKE_START_BLOCKED = "1";
  const web = startWebServer(store, options, timing);
  try {
    const r = await post(web.url, "api/broadcasts", { prompt: "after trust", new: [{ machine: "local", kind: "claude", cwd: "/tmp", count: 1 }] });
    expect(r.ok).toBe(true); const { id } = await r.json() as any;
    await until(() => web.engine.canCancelStartup(store.executions(id)[0]!.id));
    const e = store.executions(id)[0]!;
    const state = await (await fetch(web.url + "api/state")).json() as any;
    expect(state.state.broadcasts[0].executions[0].can_cancel_start).toBe(true);
    if (action === "cancel") expect((await post(web.url, `api/executions/${e.id}/cancel`, {})).ok).toBe(true);
    else { expect(await web.drain(5000)).toBe(true); web.resume(); }
    await web.engine.settle();
    expect(store.execution(e.id)!.state).toBe(action === "cancel" ? "cancelled" : "failed");
    expect(fake.server().agents).toHaveLength(1); expect(fake.server().prompts).toEqual([]);
    fake.setStatus("local", e.pane_id!, "idle"); await web.engine.refresh("local"); await web.engine.settle();
    expect(fake.server().prompts).toEqual([]);
  } finally { delete process.env.FAKE_START_BLOCKED; await web.stop(); store.close(); fake.cleanup(); }
});

test("history deletion waits for delivery and never retracts a message from the agent", async () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile), a = fake.addAgent("local", "claude", "working");
  fake.mutate(s => { s.servers.local!.promptDelayMs = 300; });
  const web = startWebServer(store, options, timing);
  try {
    const r = await post(web.url, "api/broadcasts", { prompt: "keep in agent", targets: [{ machine: "local", pane: a.pane_id, terminal_id: a.terminal_id }] });
    const { id } = await r.json() as any;
    const remove = () => fetch(web.url + `api/broadcasts/${id}`, { method: "DELETE", headers: { origin: web.url } });
    expect((await remove()).status).toBe(409);
    const e = store.executions(id)[0]!;
    expect((await post(web.url, `api/executions/${e.id}/cancel`, {})).status).toBe(410);
    await until(() => store.execution(e.id)?.state === "sent");
    const snapshot = await (await fetch(web.url + "api/state")).json() as any;
    expect(snapshot.state.broadcasts[0].executions[0]).toMatchObject({ state: "sent", agent_status: "working" });
    expect((await remove()).status).toBe(200); expect(store.getBroadcast(id)).toBeNull();
    await web.engine.settle();
    expect(web.engine.identityPending(e.id)).toBe(false);
    expect(fake.server().prompts.map(p => p.text)).toEqual(["keep in agent"]);
    expect(fake.server().agents).toHaveLength(1);
  } finally { await web.stop(); store.close(); fake.cleanup(); }
});
