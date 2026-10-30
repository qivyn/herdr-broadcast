import { afterEach, beforeEach, expect, test } from "bun:test";
import { FakeHerdr, until } from "./helpers.ts";
import { Store } from "../src/db.ts";
import { startWebServer } from "../src/web/server.ts";
import { sameProcess } from "../src/manual-session.ts";

let fake: FakeHerdr, store: Store, web: ReturnType<typeof startWebServer> | undefined;
beforeEach(() => { fake = new FakeHerdr(); store = new Store(fake.dbFile); });
afterEach(async () => { await web?.stop(); web = undefined; store.close(); fake.cleanup(); });
async function post(path: string, body: unknown = {}) {
  const base = web!.url.replace(/\/$/, "");
  return fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function setup() {
  const agent = fake.addAgent("local", "unrecognized"); fake.removeAgent("local", agent.pane_id);
  fake.mutate(s => { s.servers.local!.processes = { [agent.pane_id]: [{ pid: process.pid, name: "test-agent" }] }; });
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
  await web.engine.refreshMachines();
  return agent;
}
test("unrecognized terminal requires explicit binding, sends through raw input, and inherits across rounds", async () => {
  const a = await setup();
  const target = { machine: "local", pane: a.pane_id, terminal_id: a.terminal_id, manual: true };
  expect((await post("/api/broadcasts", { prompt: "one", targets: [target] })).ok).toBe(false);
  expect((await post("/api/machines/local/manual-binding", target)).ok).toBe(true);
  const submitted = await post("/api/broadcasts", { prompt: "one", targets: [target] });
  expect(submitted.ok).toBe(true);
  const { id } = await submitted.json() as any;
  await until(() => store.executions(id)[0]!.state === "sent");
  const e = store.executions(id)[0]!;
  expect(e.session_value).toBeNull(); expect(e.agent_kind).toBe("custom");
  expect(store.continuation(`execution:${e.id}`)?.status).toBe("uncertain");
  const follow = await post(`/api/broadcasts/${id}/follow-up`, { prompt: "two", targets: [{ execution_id: e.id, terminal_id: e.terminal_id }] });
  expect(follow.ok).toBe(true);
  await until(() => store.executions(id).length === 2 && store.executions(id)[1]!.state === "sent");
  expect(fake.server().prompts.map(p => p.text)).toEqual(["one", "two"]);
  expect(fake.calls().some(c => c.includes('"agent","prompt"'))).toBe(false);
  fake.mutate(s => { s.servers.local!.processes![a.pane_id] = []; });
  expect((await post(`/api/broadcasts/${id}/follow-up`, { prompt: "shell must not receive", targets: [{ execution_id: e.id, terminal_id: e.terminal_id }] })).ok).toBe(false);
  expect(fake.server().prompts).toHaveLength(2);
  fake.mutate(s => { s.servers.local!.processes![a.pane_id] = [{ pid: process.pid, name: "test-agent" }]; });
  expect((await post(`/api/broadcasts/${id}/follow-up`, { prompt: "still requires confirmation", targets: [{ execution_id: e.id, terminal_id: e.terminal_id }] })).ok).toBe(false);
  expect((await post(`/api/executions/${e.id}/confirm-session`, { terminal_id: e.terminal_id })).ok).toBe(true);
  const binding = store.continuation(`execution:${e.id}`)!;
  store.saveContinuation({ ...binding, manual_process: { ...binding.manual_process!, lifetime: "previous-service-process" } });
  expect((await post(`/api/broadcasts/${id}/follow-up`, { prompt: "restart must require confirmation", targets: [{ execution_id: e.id, terminal_id: e.terminal_id }] })).ok).toBe(false);
  expect(fake.server().prompts).toHaveLength(2);
});
test("manual recovery creates one plain terminal, never starts a guessed agent or replays history", async () => {
  const a = await setup();
  const id = store.createBroadcast({ title: "manual", prompt: "never replay", executions: [{ machine_id: "local", machine_label: "local", target_kind: "existing", agent_kind: "custom", cwd: "/tmp", pane_id: a.pane_id, terminal_id: a.terminal_id }] });
  const e = store.executions(id)[0]!; store.update(e.id, { state: "sent" });
  fake.mutate(s => { s.servers.local!.panes = []; });
  const before = fake.server().workspaces.length;
  const responses = await Promise.all([post(`/api/executions/${e.id}/continue`), post(`/api/executions/${e.id}/continue`)]);
  expect(responses.every(r => r.ok)).toBe(true);
  expect(fake.server().workspaces).toHaveLength(before + 1);
  expect(fake.calls().some(c => c.includes('"agent","start"'))).toBe(false);
  expect(fake.server().prompts).toEqual([]);
  const state = await (await fetch(web!.url + "api/state")).json() as any;
  expect(state.state.broadcasts[0].executions[0]).toMatchObject({ can_confirm_session: true, manual_session: true, identity_state: "unknown" });
});
test("PID reuse, executable replacement and missing continuity are distinct from the original process", () => {
  const original = [{ pid: 123, started: "boot:10", name: "agent" }];
  expect(sameProcess(original, [{ ...original[0]!, started: "boot:11" }])).toBe(false);
  expect(sameProcess(original, [{ ...original[0]!, name: "sh" }])).toBe(false);
  expect(sameProcess(original, [])).toBe(false);
  expect(sameProcess(original, original)).toBe(true);
});

test("exit after paste preserves uncertainty and never sends Enter to the shell", async () => {
  const a = await setup();
  const target = { machine: "local", pane: a.pane_id, terminal_id: a.terminal_id, manual: true };
  expect((await post("/api/machines/local/manual-binding", target)).ok).toBe(true);
  fake.mutate(s => { s.servers.local!.exitAfterPaste = true; });
  const response = await post("/api/broadcasts", { prompt: "partial input", targets: [target] });
  expect(response.ok).toBe(true);
  const { id } = await response.json() as any;
  await until(() => store.executions(id)[0]!.state === "uncertain");
  expect(store.executions(id)[0]).toMatchObject({ input_attempted: 1, state: "uncertain" });
  expect(fake.server().typed).toHaveLength(1);
  expect(fake.server().prompts).toEqual([]);
  expect(fake.calls().some(c => c.includes('"pane","send-keys"'))).toBe(false);
  await web!.engine.refresh("local");
  expect(fake.server().typed).toHaveLength(1);
});
