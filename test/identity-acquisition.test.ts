import { afterEach, beforeEach, expect, test } from "bun:test";
import { Store, type Execution } from "../src/db.ts";
import { acquireIdentity } from "../src/identity-acquisition.ts";
import { Engine } from "../src/engine.ts";
import { Conversations, continuationKey } from "../src/continuation.ts";
import { fakeLaunchArgs, FakeHerdr, until } from "./helpers.ts";
import { AGENTS } from "../src/agents.ts";
import type { SessionDiscovery } from "../src/session-discovery.ts";

let fake: FakeHerdr, store: Store;
const id = "01234567-1234-4567-89ab-0123456789ab";
beforeEach(() => { fake = new FakeHerdr(); store = new Store(fake.dbFile); });
afterEach(() => { store.close(); fake.cleanup(); });
function fixture(kind = "codex") {
  const a = fake.addAgent("local", kind);
  const b = store.createBroadcast({ title: "test", prompt: "unique first text", executions: [{ ...a, machine_id: "local", machine_label: "Local", target_kind: "existing", agent_kind: kind }] });
  const e = store.executions(b)[0]!;
  store.update(e.id, { state: "sent", sent_at: Date.now(), input_attempted: 1 });
  return store.execution(e.id)!;
}
function report(e: Execution, value = id, kind = "id") { fake.mutate(s => { s.servers.local!.agents.find(a => a.pane_id === e.pane_id)!.agent_session = { agent: e.agent_kind!, kind, value, source: "herdr:" + e.agent_kind }; }); }
const found = async (): Promise<SessionDiscovery> => ({ status: "found", session: { kind: "id", value: id } });

test("a delayed ID must match this delivery's unique history, and never fills an unrelated old execution", async () => {
  const e = fixture(), old = fixture(); report(e); report(old);
  const runner = new AbortController();
  await acquireIdentity(store, e, runner.signal, 2000, async (checked, b) => {
    expect(checked.id).toBe(e.id); expect(b.prompt).toBe("unique first text"); return found();
  });
  expect(store.execution(e.id)?.session_value).toBe(id);
  expect(store.execution(old.id)?.session_value).toBeNull();
  expect(store.continuation(`identity:${e.id}`)?.identity_source).toBe("history");
});
for (const status of ["none", "ambiguous", "unavailable", "wrong-id", "replacement", "abort"] as const) test(`delayed identity stays unknown on ${status}`, async () => {
  const e = fixture(); report(e); const abort = new AbortController();
  await acquireIdentity(store, e, abort.signal, 350, async () => {
    if (status === "replacement") fake.mutate(s => { s.servers.local!.agents[0]!.terminal_id = "replacement"; });
    if (status === "abort") abort.abort();
    return status === "wrong-id" ? { status: "found", session: { kind: "id", value: "another" } }
      : status === "replacement" || status === "abort" ? found() : { status };
  });
  expect(store.execution(e.id)).toMatchObject({ state: "sent", session_value: null });
  expect(fake.server().prompts).toHaveLength(0);
});

test("manual Codex confirmation keeps native acquisition intent and promotes only the explicit parent after a verified follow-up", async () => {
  const e = fixture(), unrelated = fixture();
  fake.mutate(s => { s.servers.local!.agents[0]!.interactive_ready = true; s.servers.local!.processes = { [e.pane_id!]: [{ pid: process.pid, name: "codex" }, { pid: process.ppid, name: "git" }] }; });
  const engine = new Engine(store, () => {}, { identityWaitMs: 0 }, fakeLaunchArgs);
  await engine.refreshMachines();
  const conversations = new Conversations(store, engine, () => {});
  try {
    await conversations.confirmSession(e, e.terminal_id);
    const binding = store.continuation(continuationKey(e))!;
    expect(binding).toMatchObject({ confirmed_session: true, manual_required: true, native_pending: { execution_id: e.id } });
    expect(store.execution(e.id)?.session_value).toBeNull();
    const round = store.createRound(e.broadcast_id, "follow up selection", [{ ...e, continuation_source: continuationKey(e), parent_execution_id: e.id }]);
    const child = store.executions(e.broadcast_id).find(x => x.round_id === round.id)!;
    store.update(child.id, { state: "sent", input_attempted: 1, sent_at: Date.now() }); report(e);
    await acquireIdentity(store, store.execution(child.id)!, new AbortController().signal, 2000, async (_e, b) => {
      expect(b.prompt).toBe("follow up selection");
      fake.mutate(s => { s.servers.local!.processes![e.pane_id!] = [{ pid: process.pid, name: "codex" }]; });
      return found();
    });
    expect(store.execution(child.id)?.session_value).toBe(id);
    expect(store.execution(e.id)?.session_value).toBe(id);
    expect(store.execution(unrelated.id)?.session_value).toBeNull();
    expect(store.continuation(continuationKey(store.execution(e.id)!))).toMatchObject({ status: "ready", manual_required: false });
    expect(fake.server().prompts).toHaveLength(0);
  } finally { engine.stop(); await engine.settle(); }
});

test("a changed explicit confirmation token cannot be retroactively filled by its old child", async () => {
  const e = fixture();
  const binding = { key: continuationKey(e), pane_id: e.pane_id!, terminal_id: e.terminal_id!, workspace_id: e.workspace_id!, tab_id: e.tab_id!, workspace_label: "Test", status: "launched" as const, error: null, confirmed_session: true, native_pending: { token: "original", execution_id: e.id } };
  store.saveContinuation(binding);
  const round = store.createRound(e.broadcast_id, "child text", [{ ...e, continuation_source: continuationKey(e), parent_execution_id: e.id }]);
  const child = store.executions(e.broadcast_id).find(x => x.round_id === round.id)!;
  store.update(child.id, { state: "sent", sent_at: Date.now(), input_attempted: 1 }); report(e);
  await acquireIdentity(store, store.execution(child.id)!, new AbortController().signal, 2000, async () => {
    store.saveContinuation({ ...binding, native_pending: { token: "reconfirmed", execution_id: e.id } });
    return found();
  });
  expect(store.execution(child.id)?.session_value).toBe(id);
  expect(store.execution(e.id)?.session_value).toBeNull();
});

test("proof arriving beyond the acquisition window cannot bind history", async () => {
  const e = fixture(); report(e);
  await acquireIdentity(store, e, new AbortController().signal, 350, async () => { await Bun.sleep(200); return found(); });
  expect(store.execution(e.id)?.session_value).toBeNull();
});

for (const agent of ["codex", "claude", "pi"]) test(`${agent} ordinary submit acquires a delayed ID using the candidate, and restart never replays`, async () => {
  const e = fixture(agent), old = fixture(agent);
  store.update(e.id, { state: "submitting", sent_at: null, input_attempted: 0 });
  const session = { kind: agent === "pi" ? "path" as const : "id" as const, value: agent === "pi" ? "/tmp/reported-session.jsonl" : id };
  let proofs = 0;
  const engine = new Engine(store, () => {}, { identityWaitMs: 2000 }, fakeLaunchArgs, async (checked, b, expected) => {
    expect(checked.id).toBe(e.id); expect(b.prompt).toBe("unique first text"); expect(expected).toEqual(session);
    if (++proofs === 1) return { status: "unavailable", reason: "incomplete" };
    return { status: "found", session };
  });
  try {
    await engine.refreshMachines(); engine.submit(e.round_id);
    await until(() => store.execution(e.id)?.state === "sent" && engine.identityPending(e.id));
    expect(store.execution(e.id)?.session_value).toBeNull();
    report(e, session.value, session.kind);
    await engine.settle();
    expect(store.execution(e.id)?.session_value).toBe(session.value);
    expect(store.execution(old.id)?.session_value).toBeNull();
    expect(store.continuation(`identity:${e.id}`)?.identity_check).toMatchObject({ state: "bound", reported_at: expect.any(Number) });
    engine.stop();
    const restarted = new Engine(store, () => {}, { identityWaitMs: 2000 }, fakeLaunchArgs);
    try { await restarted.refreshMachines(); await restarted.refresh("local"); expect(restarted.identityPending(e.id)).toBe(false); }
    finally { restarted.stop(); await restarted.settle(); }
    expect(fake.server().prompts).toHaveLength(1);
  } finally { engine.stop(); await engine.settle(); }
});

for (const kind of AGENTS.map(a => a.kind).filter(k => !["codex", "claude", "pi"].includes(k))) test(`${kind} reports unsupported late verification instead of inventing evidence`, async () => {
  const e = fixture(kind); report(e);
  await acquireIdentity(store, e, new AbortController().signal, 2000, async () => { throw new Error("must not guess a format"); });
  expect(store.execution(e.id)?.session_value).toBeNull();
  expect(store.continuation(`identity:${e.id}`)?.identity_check?.state).toBe("unsupported");
});

test("report timeout, proof timeout and read failure stay distinct and persist without a live worker", async () => {
  const a = fixture(), b = fixture(), c = fixture(); report(b); report(c);
  await acquireIdentity(store, a, new AbortController().signal, 280);
  await acquireIdentity(store, b, new AbortController().signal, 380, async () => ({ status: "none" }));
  await acquireIdentity(store, c, new AbortController().signal, 2000, async () => ({ status: "unavailable", reason: "read_limit" }));
  store.close(); store = new Store(fake.dbFile);
  expect(store.continuation(`identity:${a.id}`)?.identity_check).toMatchObject({ state: "report_timeout" });
  expect(store.continuation(`identity:${b.id}`)?.identity_check).toMatchObject({ state: "proof_timeout", reported_at: expect.any(Number) });
  expect(store.continuation(`identity:${c.id}`)?.identity_check).toMatchObject({ state: "unavailable", reason: "read_limit" });
  expect(fake.server().prompts).toHaveLength(0);
});

test("a candidate changing while the transcript flushes cannot bind the replacement", async () => {
  const e = fixture("claude"); report(e);
  await acquireIdentity(store, e, new AbortController().signal, 2000, async () => {
    report(e, "11234567-1234-4567-89ab-0123456789ab"); return { status: "none" };
  });
  expect(store.execution(e.id)?.session_value).toBeNull();
  expect(store.continuation(`identity:${e.id}`)?.identity_check?.state).toBe("changed");
});

test("deleting history during proof does not recreate its identity evidence", async () => {
  const e = fixture("claude"); report(e);
  await acquireIdentity(store, e, new AbortController().signal, 2000, async () => {
    store.deleteBroadcast(e.broadcast_id);
    store.db.query("DELETE FROM continuations WHERE key = ?").run(`identity:${e.id}`);
    return found();
  });
  expect(store.execution(e.id)).toBeNull();
  expect(store.continuation(`identity:${e.id}`)).toBeNull();
});

test("a newly confirmed replacement terminal cannot inherit an in-flight proof", async () => {
  const e = fixture("claude"); report(e);
  await acquireIdentity(store, e, new AbortController().signal, 2000, async () => {
    store.saveContinuation({ key: `execution:${e.id}`, pane_id: "new-pane", terminal_id: "new-terminal", workspace_id: "new-workspace",
      workspace_label: "New confirmation", tab_id: "new-tab", status: "launched", confirmed_session: true, error: null,
      native_pending: { token: "new-authority", execution_id: e.id } });
    return found();
  });
  expect(store.execution(e.id)?.session_value).toBeNull();
  expect(store.continuation(`execution:${e.id}`)?.terminal_id).toBe("new-terminal");
});

for (const kind of ["claude", "pi"]) test(`${kind} explicit no-ID confirmation keeps ancestry for the verified follow-up`, async () => {
  const e = fixture(kind), unrelated = fixture(kind);
  const engine = new Engine(store, () => {}, { identityWaitMs: 0 }, fakeLaunchArgs);
  try {
    await engine.refreshMachines();
    await new Conversations(store, engine, () => {}).confirmSession(e, e.terminal_id);
    const binding = store.continuation(continuationKey(e))!;
    expect(binding.native_pending?.execution_id).toBe(e.id);
    const round = store.createRound(e.broadcast_id, "confirmed follow up", [{ ...e, continuation_source: continuationKey(e), parent_execution_id: e.id }]);
    const child = store.executions(e.broadcast_id).find(x => x.round_id === round.id)!;
    store.update(child.id, { state: "sent", sent_at: Date.now() }); report(child);
    await acquireIdentity(store, store.execution(child.id)!, new AbortController().signal, 2000, found);
    expect(store.execution(e.id)?.session_value).toBe(id);
    expect(store.execution(unrelated.id)?.session_value).toBeNull();
  } finally { engine.stop(); await engine.settle(); }
});
