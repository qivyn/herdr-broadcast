import { afterEach, beforeEach, expect, test } from "bun:test";
import { Store, type NewExecution } from "../src/db.ts";
import { Engine, launchFailureText } from "../src/engine.ts";
import { continuationInfo } from "../src/continuation.ts";
import { fakeLaunchArgs, FakeHerdr, until, type FakeAgent } from "./helpers.ts";

let fake: FakeHerdr, store: Store, engines: Engine[];
const session = "01234567-1234-4567-89ab-0123456789ab";
const existing = (a: FakeAgent, machine = "local"): NewExecution => ({ machine_id: machine, machine_label: machine,
  target_kind: "existing", agent_kind: a.agent, pane_id: a.pane_id, terminal_id: a.terminal_id, cwd: a.cwd });
const fresh = (machine = "local", slot = 1, cwd = "/src", kind = "claude"): NewExecution => ({ machine_id: machine, machine_label: machine,
  target_kind: "new", agent_kind: kind, cwd, slot });
function engine(other = store, timing: ConstructorParameters<typeof Engine>[2] = {}) { const e = new Engine(other, () => {}, { tickMs: 20, localPollMs: 40, remotePollMs: 40, launchPollMs: 40, identityWaitMs: 0, ...timing }, fakeLaunchArgs); engines.push(e); return e; }
function record(targets: NewExecution[], prompt = "hello") { return store.createBroadcast({ title: prompt, prompt, executions: targets }); }
async function submit(id: number, e = engine()) { await e.refreshMachines(); e.submit(store.rounds(id)[0]!.id); return e; }
const result = (id: number) => store.executions(id)[0]!;
beforeEach(() => { fake = new FakeHerdr(); store = new Store(fake.dbFile); engines = []; });
afterEach(async () => { for (const e of engines) e.stop(); for (const e of engines) await e.settle(); store.close(); fake.cleanup(); });

for (const machine of ["local", "remote"]) test(`the ${machine} prompt response saves only this delivery's session, and allows exact restore`, async () => {
  if (machine !== "local") fake.addMachine(machine, "Remote");
  const a = fake.addAgent(machine, "claude"), older = record([existing(a, machine)]), e = await submit(older);
  await e.settle();
  const reference = { agent: "claude", kind: "id", source: "herdr:claude", value: session };
  fake.mutate(s => { s.servers[machine]!.promptReply = { agent_session: reference }; });
  const id = record([existing(a, machine)]); e.submit(store.rounds(id)[0]!.id); await e.settle();
  expect(result(id)).toMatchObject({ state: "sent", session_kind: "id", session_value: session });
  expect(result(older).session_value).toBeNull();
  fake.mutate(s => { s.servers[machine]!.agents[0]!.agent_session = reference; });
  await e.refresh(machine);
  expect(continuationInfo(store, e, result(id)).terminal_state).toBe("live");
  expect(result(older).session_value).toBeNull();
  fake.removeAgent(machine, a.pane_id); await e.refresh(machine);
  expect(continuationInfo(store, e, result(id))).toMatchObject({ terminal_state: "closed", can_resume: true, resume_mode: "saved" });
  expect(fake.server(machine).prompts).toHaveLength(2);
});

for (const reply of ["absent", "without-session", "empty-session"]) test(`a successful response ${reply} preserves the pre-send identity`, async () => {
  const a = fake.addAgent("local", "pi"), id = record([existing(a)]);
  fake.mutate(s => {
    s.servers.local!.agents[0]!.agent_session = { agent: "pi", kind: "path", source: "herdr:pi", value: "/sessions/original.jsonl" };
    s.servers.local!.promptReply = reply === "absent" ? null : { agent_session: reply === "without-session" ? null : { agent: "pi", kind: "id", source: "herdr:pi", value: "" } };
  });
  const e = await submit(id); await e.settle();
  expect(result(id)).toMatchObject({ state: "sent", session_kind: "path", session_value: "/sessions/original.jsonl" });
  expect(fake.server().prompts).toHaveLength(1);
});

for (const change of ["terminal", "pane", "agent", "session-agent", "session-kind", "known-session"]) test(`conflicting ${change} in the prompt response cannot bind a replacement or trigger a retry`, async () => {
  const a = fake.addAgent("local", "claude"), id = record([existing(a)]);
  const reference = { agent: "claude", kind: "id", source: "herdr:claude", value: session };
  fake.mutate(s => {
    const server = s.servers.local!;
    const reply: Partial<FakeAgent> = { agent_session: { ...reference } };
    if (change === "terminal") reply.terminal_id = "replacement";
    if (change === "pane") reply.pane_id = "w9:p9";
    if (change === "agent") reply.agent = "pi";
    if (change === "session-agent") reply.agent_session!.agent = "pi";
    if (change === "session-kind") reply.agent_session!.kind = "unknown";
    if (change === "known-session") { server.agents[0]!.agent_session = reference; reply.agent_session!.value = "other-session"; }
    server.promptReply = reply;
  });
  const e = await submit(id); await e.settle();
  expect(result(id)).toMatchObject({ state: "uncertain", input_attempted: 1, session_value: change === "known-session" ? session : null });
  expect(result(id).error).toContain("身份与目标不一致");
  await e.refresh("local"); e.stop(); const restarted = engine(); restarted.start(); await restarted.settle();
  expect(fake.server().prompts).toHaveLength(1);
  expect(fake.calls().filter(c => c.includes('"agent","prompt"'))).toHaveLength(1);
});

test("raw fallback retains the identity learned before agent.prompt refused input", async () => {
  const a = fake.addAgent("local", "pi", "idle", null, true), id = record([existing(a)]);
  fake.mutate(s => {
    const reference = { agent: "pi", kind: "id", source: "herdr:pi", value: session };
    s.servers.local!.agents[0]!.agent_session = reference;
    s.servers.local!.promptRefusalSession = { ...reference, value: "replacement" };
  });
  const e = await submit(id); await e.settle();
  expect(result(id).session_value).toBe(session);
  expect(result(id).state).not.toBe("sent");
  expect(fake.server().prompts).toEqual([]); expect(fake.server().typed ?? []).toEqual([]);
});

for (const state of ["sent", "uncertain"] as const) test(`${state} history without a session ID never adopts a later conversation in the same terminal`, async () => {
  const a = fake.addAgent("local", "claude"), id = record([existing(a)]);
  if (state === "uncertain") fake.mutate(s => { s.servers.local!.failNext = { "agent prompt": ["timeout"] }; });
  const first = await submit(id); await first.settle();
  expect(result(id)).toMatchObject({ state, session_value: null });
  const saved = result(id), prompts = fake.server().prompts;
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value: session }; });
  await first.refresh("local"); await first.refresh("local");
  expect(result(id)).toEqual(saved);
  first.stop();
  const restarted = engine(); restarted.start(); await restarted.refresh("local"); await restarted.settle();
  expect(result(id)).toEqual(saved);
  expect(continuationInfo(store, restarted, result(id))).toMatchObject({ terminal_state: "restoring", can_confirm_session: true, execution: { session_value: null } });
  expect(fake.server().prompts).toEqual(prompts);
});

for (const status of ["idle", "working", "done"] as const) test(`an agent that is ${status} receives immediately; later activity never changes delivery`, async () => {
  const a = fake.addAgent("local", "claude", status), id = record([existing(a)]), e = await submit(id);
  await e.settle();
  expect(result(id)).toMatchObject({ state: "sent", input_attempted: 1, seq_before: null, saw_working: 0 });
  expect(result(id).finished_at).not.toBeNull();
  const delivered = result(id);
  fake.quickTurn("local", a.pane_id); await e.refresh("local");
  fake.removeAgent("local", a.pane_id); await e.refresh("local");
  expect(result(id)).toEqual(delivered);
  expect(fake.server().prompts).toEqual([{ pane_id: a.pane_id, text: "hello" }]);
});

test("two broadcasts and follow-up rounds reach a working agent without waiting for a turn", async () => {
  const a = fake.addAgent("local", "claude", "working"), target = existing(a);
  const first = record([target], "first"), second = record([target], "second"), e = await submit(first);
  e.submit(store.rounds(second)[0]!.id);
  const round = store.createRound(first, "follow up", [target]); e.submit(round.id);
  await e.settle();
  expect(fake.server().prompts.map(p => p.text)).toEqual(["first", "second", "follow up"]);
  expect(fake.server().agents[0]!.agent_status).toBe("working");
  expect(store.executions(first).every(r => r.state === "sent")).toBe(true);
  expect(store.rounds(first).map(r => r.counts)).toEqual([{ sent: 1 }, { sent: 1 }]);
});

test("blocked, offline and unavailable targets fail once without blocking other recipients or later auto-sending", async () => {
  fake.addMachine("remote", "Remote");
  const blocked = fake.addAgent("local", "claude", "blocked"), good = fake.addAgent("local", "codex", "working"), offline = fake.addAgent("remote", "pi");
  fake.mutate(s => { s.servers.remote!.unreachable = true; });
  const id = record([existing(blocked), existing(good), existing(offline, "remote")]), e = await submit(id);
  await e.settle();
  expect(store.executions(id).map(r => r.state)).toEqual(["failed", "sent", "failed"]);
  expect(store.executions(id)[0]!.input_attempted).toBe(0);
  fake.setStatus("local", blocked.pane_id, "idle"); fake.mutate(s => { s.servers.remote!.unreachable = false; });
  await e.refresh("local"); await e.refresh("remote"); e.pause(); e.resume(); await e.settle();
  expect(fake.server().prompts).toEqual([{ pane_id: good.pane_id, text: "hello" }]);
  expect(fake.server("remote").prompts).toEqual([]);
});

for (const change of ["terminal", "session", "missing-session", "kind"]) test(`${change} is checked immediately before input, including busy agents`, async () => {
  const a = fake.addAgent("local", "claude", "working"), id = record([{ ...existing(a), session_kind: "id", session_value: session }]);
  fake.mutate(s => { const a = s.servers.local!.agents[0]!; a.agent_session = { agent: "claude", kind: "id", source: "test", value: session };
    if (change === "terminal") a.terminal_id = "replacement";
    if (change === "session") a.agent_session.value = "other";
    if (change === "missing-session") a.agent_session = null;
    if (change === "kind") a.agent = "pi";
  });
  const e = await submit(id); await e.settle();
  expect(result(id).state).toBe("failed"); expect(result(id).input_attempted).toBe(0);
  expect(fake.server().prompts).toEqual([]); expect(fake.server().typed ?? []).toEqual([]);
});

test("self-reported busy agents get whole multiline pastes; concurrent submissions cannot interleave paste and Enter", async () => {
  const a = fake.addAgent("local", "fakebot", "working", null, true);
  const one = record([existing(a)], "first\nline"), two = record([existing(a)], "second\nline"), e = await submit(one);
  e.submit(store.rounds(two)[0]!.id); await e.settle();
  expect(fake.server().prompts.map(p => p.text)).toEqual(["\x1b[200~first\nline\x1b[201~", "\x1b[200~second\nline\x1b[201~"]);
});

for (const custom of [false, true]) test(`${custom ? "partial paste" : "timeout"} is uncertain and never replayed by refresh or restart`, async () => {
  const a = fake.addAgent("local", "claude", "working", null, custom), id = record([{ ...existing(a), target_kind: "new" }]);
  fake.mutate(s => { s.servers.local!.failNext = { [custom ? "pane send-keys" : "agent prompt"]: [custom ? "pane_not_found" : "timeout"] }; });
  const e = await submit(id); await e.settle();
  expect(result(id)).toMatchObject({ state: "uncertain", input_attempted: 1 });
  expect(result(id).sent_at).not.toBeNull();
  if (custom) expect(fake.server().typed).toEqual([{ pane_id: a.pane_id, text: "hello" }]);
  const before = fake.calls().filter(c => c.includes('"agent","prompt"')).length;
  e.stop(); const next = engine(); next.start(); await next.refresh("local"); await next.settle();
  expect(fake.calls().filter(c => c.includes('"agent","prompt"'))).toHaveLength(before);
  fake.removeAgent("local", a.pane_id);
  await expect(next.retry(result(id))).rejects.toThrow("恢复原会话");
});

test("explicit duplicate submissions across engines claim the same request once", async () => {
  const id = record([existing(fake.addAgent("local", "claude", "working"))]);
  const other = new Store(fake.dbFile), one = engine(), two = engine(other);
  try {
    const round = store.rounds(id)[0]!.id;
    one.submit(round); two.submit(round); one.submit(round);
    await one.settle(); await two.settle();
    expect(fake.server().prompts).toHaveLength(1);
  } finally { two.stop(); await two.settle(); other.close(); }
});

test("startup retires old queues, preserves history and never resumes interrupted submissions", async () => {
  const a = fake.addAgent("local", "claude"), id = record(Array.from({ length: 5 }, () => existing(a)));
  const rows = store.executions(id);
  store.update(rows[0]!.id, { state: "queued" });
  store.update(rows[1]!.id, { state: "working", sent_at: 10 });
  store.update(rows[2]!.id, { state: "sending", owner_pid: 2147483647 });
  store.update(rows[3]!.id, { state: "completed", finished_at: 20 });
  const historical = store.execution(rows[3]!.id);
  const e = engine(); e.start(); await e.refresh("local"); await e.settle();
  expect(store.executions(id).map(r => r.state)).toEqual(["cancelled", "sent", "uncertain", "completed", "failed"]);
  expect(store.execution(rows[3]!.id)).toEqual(historical);
  expect(fake.server().prompts).toEqual([]);
  expect(store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 9 });
});

for (const machine of ["local", "remote"]) test(`new agents on ${machine} share a workspace with separate folders and receive directly`, async () => {
  if (machine !== "local") fake.addMachine(machine, "Remote");
  const id = record([fresh(machine, 1, "/src/app"), fresh(machine, 2, "/src/api", "pi")]);
  const e = await submit(id); await e.settle();
  const rows = store.executions(id);
  expect(rows.map(r => r.state)).toEqual(["sent", "sent"]);
  expect(rows[0]!.workspace_id).toBe(rows[1]!.workspace_id); expect(rows[0]!.pane_id).not.toBe(rows[1]!.pane_id);
  expect(fake.server(machine).prompts).toHaveLength(2);
  expect(fake.calls().filter(c => c.includes('"workspace","create"'))).toHaveLength(1);
  expect(fake.calls().filter(c => c.includes('"tab","create"'))).toHaveLength(1);
});

for (const machine of ["local", "remote"]) test(`a new ${machine} agent waits for startup confirmation and sends once without blocking other recipients`, async () => {
  process.env.FAKE_START_BLOCKED = "1";
  try {
    if (machine !== "local") fake.addMachine(machine, "Remote");
    const other = fake.addAgent("local", "pi", "working");
    const id = record([fresh(machine), existing(other)]), e = await submit(id);
    await until(() => e.canCancelStartup(result(id).id) && store.executions(id)[1]!.state === "sent");
    expect(result(id)).toMatchObject({ state: "starting", input_attempted: 0, sent_at: null, error: null });
    expect(fake.server(machine).prompts.filter(p => p.pane_id === result(id).pane_id)).toEqual([]);
    delete process.env.FAKE_START_BLOCKED;
    fake.setStatus(machine, result(id).pane_id!, "idle"); await e.settle();
    await e.refresh(machine); await e.settle();
    expect(result(id).state).toBe("sent"); expect(e.canCancelStartup(result(id).id)).toBe(false);
    expect(fake.server(machine).prompts.filter(p => p.pane_id === result(id).pane_id)).toEqual([{ pane_id: result(id).pane_id!, text: "hello" }]);
    expect(store.rounds(id)).toHaveLength(1);
    expect(fake.calls().filter(c => c.includes('"agent","start"'))).toHaveLength(1);
  } finally { delete process.env.FAKE_START_BLOCKED; }
});

for (const action of ["cancel", "pause", "stop", "timeout"]) test(`${action} ends startup waiting without sending later or replaying on restart`, async () => {
  process.env.FAKE_START_BLOCKED = "1";
  try {
    const id = record([fresh()]), e = await submit(id, engine(store, { startupConfirmMs: action === "timeout" ? 100 : 5000 }));
    await until(() => fake.calls().some(c => c.includes('"agent","wait"')));
    if (action === "cancel") expect(e.cancelStartup(result(id).id)).toBe(true);
    else if (action === "pause") { e.pause(); e.resume(); }
    else if (action === "stop") e.stop();
    await e.settle();
    expect(result(id)).toMatchObject({ state: action === "cancel" ? "cancelled" : "failed", input_attempted: 0, sent_at: null });
    expect(e.canCancelStartup(result(id).id)).toBe(false);
    const saved = result(id);
    fake.setStatus("local", saved.pane_id!, "idle"); await e.refresh("local");
    e.stop(); const restarted = engine(); restarted.start(); await restarted.refresh("local"); await restarted.settle();
    expect(result(id)).toEqual(saved); expect(fake.server().prompts).toEqual([]);
    expect(fake.calls().filter(c => c.includes('"agent","start"'))).toHaveLength(1);
  } finally { delete process.env.FAKE_START_BLOCKED; }
});

for (const change of ["terminal", "kind", "name", "exit"]) test(`startup wait cannot send after its agent changes (${change})`, async () => {
  process.env.FAKE_START_BLOCKED = "1";
  try {
    const id = record([fresh()]), e = await submit(id);
    await until(() => fake.calls().some(c => c.includes('"agent","wait"')));
    fake.mutate(s => {
      const a = s.servers.local!.agents[0]!;
      if (change === "exit") s.servers.local!.agents = [];
      else { if (change === "terminal") a.terminal_id = "replacement"; if (change === "kind") a.agent = "pi"; if (change === "name") a.name = "replacement"; a.agent_status = "idle"; }
    });
    await e.settle();
    expect(result(id)).toMatchObject({ state: "failed", input_attempted: 0, sent_at: null });
    expect(fake.server().prompts).toEqual([]);
    expect(fake.calls().filter(c => c.includes('"agent","start"'))).toHaveLength(1);
  } finally { delete process.env.FAKE_START_BLOCKED; }
});

test("missing commands fail promptly and leave an inspectable shell with proven-unsent evidence", async () => {
  fake.mutate(s => { s.servers.local!.missingKinds = ["codex"]; });
  const id = record([fresh("local", 1, "/src", "codex")]), e = await submit(id);
  await until(() => result(id).state === "failed", 8000);
  await e.settle();
  expect(result(id)).toMatchObject({ input_attempted: 0, sent_at: null });
  expect(result(id).error).toContain("command not found");
  expect(continuationInfo(store, e, result(id)).terminal_state).toBe("shell");
  fake.mutate(s => { s.servers.local!.missingKinds = []; });
  const retry = await e.retry(result(id)); await e.settle();
  const next = store.executions(id).find(r => r.round_id === retry.id)!;
  expect(next.state).toBe("sent"); expect(next.pane_id).not.toBe(result(id).pane_id);
});

test("launch failure extraction retains the shell error", () => {
  expect(launchFailureText("% codex\nzsh: command not found: codex\n% ")).toBe("% codex\nzsh: command not found: codex");
});

test("slow submission preserves the input timestamp and finishes independently of AI work", async () => {
  const a = fake.addAgent("local", "claude", "working"); fake.mutate(s => { s.servers.local!.promptDelayMs = 300; });
  const id = record([existing(a)]), e = await submit(id); await e.settle();
  expect(result(id).finished_at! - result(id).sent_at!).toBeGreaterThanOrEqual(250);
  expect(fake.server().agents[0]!.agent_status).toBe("working");
});

test("retry is explicit, uses the original session, preserves failure and deduplicates concurrent requests", async () => {
  const a = fake.addAgent("local", "claude", "working");
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value: session }; });
  const id = record([{ ...existing(a), session_kind: "id", session_value: session }]), e = engine();
  store.update(result(id).id, { state: "failed", error: "not sent" });
  const original = result(id), [one, two] = await Promise.all([e.retry(original), e.retry(original)]);
  expect(one.id).toBe(two.id); await e.settle();
  expect(result(id)).toEqual(original); expect(store.rounds(id)).toHaveLength(2); expect(fake.server().prompts).toHaveLength(1);
  expect((await e.retry(original)).id).toBe(one.id); await e.settle(); expect(fake.server().prompts).toHaveLength(1);
});

test("interrupt operates on the live agent and does not change any delivery result", async () => {
  const a = fake.addAgent("local", "claude", "working"), id = record([existing(a)]);
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value: session }; });
  const e = await submit(id); await e.settle();
  const sent = result(id);
  await expect(e.interrupt(sent, "replacement")).rejects.toThrow("身份已变化");
  await e.interrupt(sent, a.terminal_id); fake.setStatus("local", a.pane_id, "idle"); await e.refresh("local");
  expect(result(id)).toEqual(sent); expect(fake.calls().filter(c => c.includes('"ctrl+c"'))).toHaveLength(1);
});

test("legacy queued records without proof of non-delivery remain uncertain across migration", async () => {
  const id = record([existing(fake.addAgent("local", "claude"))]);
  store.update(result(id).id, { state: "queued", input_attempted: null });
  const e = engine(); e.start(); await e.settle();
  expect(result(id).state).toBe("uncertain"); expect(result(id).note).toContain("无法确认");
  expect(fake.server().prompts).toEqual([]);
  const migrated = result(id); store.retireLegacyQueue(); expect(result(id)).toEqual(migrated);
});

test("Antigravity identity arriving with a send receipt belongs only to that send", async () => {
  const a = fake.addAgent("local", "agy");
  const old = record([existing(a)]), runner = await submit(old); await runner.settle();
  const reference = { agent: "agy", kind: "id", source: "herdr:antigravity-cli", value: "conversation_abc123" };
  fake.mutate(s => { s.servers.local!.promptReply = { agent_session: reference }; });
  const id = record([existing(a)]); runner.submit(store.rounds(id)[0]!.id); await runner.settle();
  expect(result(id)).toMatchObject({ state: "sent", session_value: reference.value });
  expect(store.continuation(`identity:${result(id).id}`)?.identity_source).toBe("prompt");
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = reference; });
  await runner.refresh("local");
  expect(result(old).session_value).toBeNull();
  expect(fake.server().prompts).toHaveLength(2);
});

test("Codex hooks manager cannot receive task input despite Herdr reporting idle", async () => {
  const a = fake.addAgent("local", "codex");
  fake.mutate(s => { s.servers.local!.screens = { [a.pane_id]: "  Hooks\n  Lifecycle hooks from config and enabled plugins.\n  t trust all · enter review · esc close\n" }; });
  const id = record([existing(a)]), runner = await submit(id);
  await runner.settle();
  expect(result(id)).toMatchObject({ state: "failed", input_attempted: 0 });
  expect(fake.server().prompts).toHaveLength(0);
});

for (const outcome of ["ready", "cancel", "timeout", "stop"] as const) test(`Codex new broadcast waits at hook review, then ${outcome} without replay`, async () => {
  fake.mutate(s => { s.servers.local!.startScreen = "Hooks need review\nenter confirm · esc skip"; });
  const id = record([fresh("local", 1, "/src", "codex")]), runner = engine(store, { startupConfirmMs: outcome === "timeout" ? 700 : 4000 });
  await submit(id, runner);
  await until(() => runner.canCancelStartup(result(id).id));
  expect(result(id)).toMatchObject({ state: "starting", input_attempted: 0, sent_at: null });
  expect(fake.server().prompts).toHaveLength(0);
  if (outcome === "ready") fake.mutate(s => { s.servers.local!.screens![result(id).pane_id!] = "›\n100% context left"; });
  if (outcome === "cancel") runner.cancelStartup(result(id).id);
  if (outcome === "stop") runner.stop();
  await runner.settle();
  expect(result(id).state).toBe(outcome === "ready" ? "sent" : outcome === "cancel" ? "cancelled" : "failed");
  expect(fake.server().prompts).toHaveLength(outcome === "ready" ? 1 : 0);
  fake.mutate(s => { s.servers.local!.screens![result(id).pane_id!] = "›"; });
  await runner.refresh("local");
  expect(fake.server().prompts).toHaveLength(outcome === "ready" ? 1 : 0);
  expect(fake.calls().find(c => c.includes('["agent","start"'))).toContain('"--no-daemon"');
});

test("pausing ends only the live identity check; restart and polls cannot replay or resume it", async () => {
  const a = fake.addAgent("local", "codex"), id = record([existing(a)]);
  const runner = engine(store, { identityWaitMs: 30_000 });
  await submit(id, runner);
  await until(() => result(id).state === "sent" && runner.identityPending(result(id).id));
  runner.pause(); await runner.settle();
  expect(runner.identityPending(result(id).id)).toBe(false);
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "codex", kind: "id", value: session, source: "herdr:codex" }; });
  await runner.refresh("local");
  const restarted = engine(); await restarted.refresh("local");
  expect(result(id).session_value).toBeNull();
  expect(fake.server().prompts).toHaveLength(1);
});
