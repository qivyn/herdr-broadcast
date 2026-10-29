import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ACTIVE_STATES, Store, type Execution } from "../src/db.ts";
import { resumeIdentityIssue, terminalBindingKey } from "../src/conversation-target.ts";
import { Engine } from "../src/engine.ts";
import { Conversations, continuationInfo, continuationKey, resumeArgs } from "../src/continuation.ts";
import { startWebServer } from "../src/web/server.ts";
import { FakeHerdr, until } from "./helpers.ts";
import { snapshot } from "../src/web/server.ts";
import { slugOf } from "../src/weblink.ts";

const session = "01234567-1234-4567-89ab-0123456789ab";
let fake: FakeHerdr, store: Store, engine: Engine, conversations: Conversations;
let web: ReturnType<typeof startWebServer> | undefined;
beforeEach(() => {
  fake = new FakeHerdr(); store = new Store(fake.dbFile);
  engine = new Engine(store, () => {}, {});
  conversations = new Conversations(store, engine, () => {}, async () => true, async () => ({ status: "none" }));
});
afterEach(async () => {
  await conversations.settle(); await web?.stop(); web = undefined;
  engine.stop(); await engine.settle(); store.close(); fake.cleanup();
});

async function fixture(kind = "claude", machine = "local") {
  if (machine !== "local") fake.addMachine(machine, "Remote");
  const agent = fake.addAgent(machine, kind, "done");
  fake.mutate((s) => { s.servers[machine]!.agents[0]!.agent_session = { agent: kind, kind: "id", source: "integration", value: session }; });
  const id = store.createBroadcast({ title: "Original task", prompt: "must never be resent", executions: [{
    machine_id: machine, machine_label: machine, target_kind: "existing", agent_kind: kind,
    cwd: agent.cwd, pane_id: agent.pane_id, terminal_id: agent.terminal_id,
    workspace_id: agent.workspace_id, tab_id: agent.tab_id,
  }] });
  const e = store.executions(id)[0]!;
  store.update(e.id, { state: "completed", sent_at: 123, finished_at: 456, session_kind: "id", session_value: session });
  await engine.refreshMachines(); await engine.refresh(machine);
  return store.execution(e.id)!;
}
function close(e: Execution) {
  fake.mutate((s) => {
    const server = s.servers[e.machine_id]!;
    server.agents = server.agents.filter((a) => a.pane_id !== e.pane_id);
    server.panes = server.panes.filter((p) => p.pane_id !== e.pane_id);
  });
}
const starts = () => readFileSync(fake.logFile, "utf8").split("\n").filter((l) => l.includes('["agent","start"'));

for (const state of ["sent", "uncertain", "completed"] as const) test(`${state} unknown history requires confirmation before using a later session report`, async () => {
  const old = await fixture();
  store.update(old.id, { state, session_kind: null, session_value: null, input_attempted: 1 });
  const e = store.execution(old.id)!;
  await engine.refresh("local");
  expect(await conversations.target(e)).toMatchObject({ mode: "inspect", unverified_original: true, execution: { session_value: null } });
  expect(snapshot(store, engine).broadcasts[0]!.executions[0]).toMatchObject({ can_follow_up: false, can_confirm_session: true, session_value: null, restore_kind: "identity", needs_start_confirmation: false });
  expect(resumeIdentityIssue(store, e, { ...fake.server().agents[0]!, focused: false })).toBe("unconfirmed");
  expect((await conversations.continue(e, true, true)).mode).toBe("inspect");
  if (state === "uncertain") await expect(engine.retry(e)).rejects.toThrow("恢复原会话");
  expect(store.execution(e.id)).toEqual(e);
  await expect(conversations.confirmSession(e, "stale-terminal")).rejects.toThrow("终端已变化");
  await conversations.confirmSession(e, e.terminal_id);
  const confirmed = store.execution(e.id)!;
  expect(confirmed).toMatchObject({ state, session_kind: "id", session_value: session, sent_at: e.sent_at, finished_at: e.finished_at });
  expect((await new Conversations(store, engine, () => {}).target(confirmed))?.mode).toBe("reconnect");
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session!.value = "another-session"; });
  await expect(conversations.target(confirmed)).rejects.toThrow("其他会话");
  expect(store.execution(e.id)!.session_value).toBe(session);
  expect(fake.server().prompts).toEqual([]); expect(starts()).toEqual([]);
});

test("confirmation without a reported ID stays unknown when the terminal later reports a session", async () => {
  const old = await fixture();
  store.update(old.id, { state: "sent", session_kind: null, session_value: null });
  const e = store.execution(old.id)!;
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = null; });
  await conversations.confirmSession(e, e.terminal_id);
  expect((await conversations.target(e))?.mode).toBe("reconnect");
  expect(store.execution(e.id)!.session_value).toBeNull();
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value: session }; });
  await engine.refresh("local");
  expect((await new Conversations(store, engine, () => {}).target(e))?.mode).toBe("inspect");
  expect(store.execution(e.id)!.session_value).toBeNull();
  await conversations.confirmSession(e, e.terminal_id);
  expect(store.execution(e.id)!.session_value).toBe(session);
  expect(fake.server().prompts).toEqual([]); expect(starts()).toEqual([]);
});

test("a stale unknown confirmation cannot overwrite identity established by another request", async () => {
  const original = await fixture();
  const stale = { ...original, session_kind: null, session_value: null };
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session!.value = "later-session"; });
  await expect(conversations.confirmSession(stale, original.terminal_id)).rejects.toThrow("身份已变化");
  expect(store.execution(original.id)).toEqual(original);
});

test("automatic reconnect and an explicit restore do not share authorization or block each other", async () => {
  const e = await fixture(); close(e);
  const [automatic, requested] = await Promise.all([conversations.continue(e, false, true), conversations.continue(e)]);
  expect(["manual", "inspect", "reconnect"]).toContain(automatic.mode);
  expect(requested.mode).toBe("resumed"); expect(starts()).toHaveLength(1);
  expect(fake.server().prompts).toEqual([]); expect(store.execution(e.id)).toEqual(e);
});

async function chooseSecond(e: Execution) {
  const chosen = fake.addAgent("local", "claude", "idle");
  fake.mutate(s => { s.servers.local!.agents.find(a => a.terminal_id === chosen.terminal_id)!.agent_session = { agent: "claude", kind: "id", source: "test", value: session }; });
  await conversations.selectTarget(e, chosen.terminal_id);
  return chosen;
}

test("an immediate send stays on its selected physical terminal while history chooses another instance", async () => {
  const e = await fixture(), chosen = await chooseSecond(e);
  store.update(e.id, { state: "submitting", sent_at: null, finished_at: null });
  engine.submit(e.round_id); await engine.settle();
  expect(fake.server().prompts).toEqual([{ pane_id: e.pane_id!, text: "must never be resent" }]);
  close(e); await engine.refresh("local");
  expect(store.execution(e.id)!.state).toBe("sent");
  expect(store.execution(e.id)!.terminal_id).toBe(e.terminal_id);
  expect(store.continuation(continuationKey(e))!.terminal_id).toBe(chosen.terminal_id);
});

test("native launch evidence survives changing history's selected instance before any snapshot", async () => {
  const e = await fixture();
  store.saveContinuation({ key: continuationKey(e), pane_id: e.pane_id!, terminal_id: e.terminal_id!, workspace_id: e.workspace_id!, tab_id: e.tab_id!, workspace_label: "Original", status: "launched", error: null });
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = null; });
  const chosen = await chooseSecond(e);
  const active = { ...e, state: "submitting" as const };
  expect((await conversations.target(active))!.mode).toBe("reconnect");
  expect(resumeIdentityIssue(store, active, { ...fake.server().agents[0]!, focused: false })).toBeNull();
  expect(store.continuation(continuationKey(e))!.terminal_id).toBe(chosen.terminal_id);
});

for (const shell of [false, true]) {
  test(`a manual picker ${shell ? "shell" : "agent"} uses the live renamed workspace while identity is pending`, async () => {
    const old = await fixture(); close(old);
    store.update(old.id, { session_kind: null, session_value: null });
    const e = store.execution(old.id)!;
    await conversations.continue(e, true);
    const binding = store.continuation(continuationKey(e))!;
    fake.mutate(s => {
      const server = s.servers.local!;
      server.workspaces.find(w => w.workspace_id === binding.workspace_id)!.label = "Renamed picker";
      server.workspaces.find(w => w.workspace_id === e.workspace_id)!.label = binding.workspace_label;
      if (shell) server.agents = server.agents.filter(a => a.pane_id !== binding.pane_id);
    });
    await engine.refresh("local");
    const target = await conversations.target(e);
    expect(target).toMatchObject({ mode: "inspect", execution: { workspace_label: "Renamed picker", terminal_id: binding.terminal_id } });
    const shown = snapshot(store, engine).broadcasts[0]!.executions[0]!;
    expect(new URLSearchParams(shown.web_link!.slice(1)).get("ws")).toBe(`${binding.workspace_id}-${slugOf("Renamed picker")}`);
  });
}

for (const state of ACTIVE_STATES) {
  test(`history instance selection cannot move a ${state} execution or inherit another terminal's restore flags`, async () => {
    const e = await fixture(), chosen = await chooseSecond(e);
    store.update(e.id, { state });
    const active = store.execution(e.id)!;
    expect((await conversations.target(active))!.execution.terminal_id).toBe(e.terminal_id);
    const key = continuationKey(e), binding = store.continuation(key)!;
    store.saveContinuation({ ...binding, status: "starting", select_session: true, failure_kind: "unavailable", error: "other restore" });
    store.acquireLock(`continue:${key}`, () => true, 300_000);
    const info = continuationInfo(store, engine, active);
    expect(info.execution.terminal_id).toBe(e.terminal_id);
    expect(info.restore_pending ?? false).toBe(false);
    expect(info.can_abandon_restore ?? false).toBe(false);
    expect(info).not.toHaveProperty("restore_unavailable");
    close(e);
    expect(await conversations.target(active)).toBeNull();
    expect(store.continuation(key)!.terminal_id).toBe(chosen.terminal_id);
    expect(store.execution(e.id)).toEqual(active);
    expect(fake.server().prompts).toEqual([]);
  });
}

test("confirming an active original without reports preserves history's other instance through interruption and conflicting reports", async () => {
  const e = await fixture(), chosen = await chooseSecond(e), key = continuationKey(e);
  store.update(e.id, { state: "sending", saw_working: 1 });
  const active = store.execution(e.id)!;
  fake.mutate(s => { const a = s.servers.local!.agents.find(a => a.terminal_id === e.terminal_id)!; a.agent_session = null; a.interactive_ready = true; a.agent_status = "working"; });
  expect(await conversations.target(active)).toMatchObject({ mode: "inspect", unverified_original: true, execution: { terminal_id: e.terminal_id } });
  await expect(conversations.confirmSession(active, chosen.terminal_id)).rejects.toThrow("终端已变化");
  await conversations.confirmSession(active, e.terminal_id);
  expect(store.continuation(key)!.terminal_id).toBe(chosen.terminal_id);
  expect((await new Conversations(store, engine, () => {}).target(active))!.mode).toBe("reconnect");
  const agent = fake.server().agents.find(a => a.terminal_id === e.terminal_id)!;
  expect(resumeIdentityIssue(store, active, { ...agent, focused: false })).toBeNull();
  await engine.interrupt(active, e.terminal_id);
  expect(store.execution(e.id)!.state).toBe("sending");
  expect(store.continuation(key)!.terminal_id).toBe(chosen.terminal_id);
  const view = engine.view("local")!;
  const snapshotActive = snapshot(store, engine).broadcasts[0]!.executions[0]!;
  expect(snapshotActive.terminal_id).toBe(e.terminal_id);
  expect(view.agents.some(a => a.terminal_id === chosen.terminal_id)).toBe(true);
  fake.mutate(s => { const a = s.servers.local!.agents.find(a => a.terminal_id === e.terminal_id)!; a.agent_session = { agent: "claude", kind: "id", source: "test", value: "different" }; });
  expect(resumeIdentityIssue(store, active, { ...fake.server().agents.find(a => a.terminal_id === e.terminal_id)!, focused: false })).toBe("changed");
  expect(await conversations.target(active)).toBeNull();
  fake.mutate(s => { s.servers.local!.agents.find(a => a.terminal_id === e.terminal_id)!.agent_session = null; });
  expect((await conversations.target(active))!.mode).toBe("inspect");
  expect(fake.server().prompts).toEqual([]);
});

test("a chosen instance with missing reports waits for its own confirmation instead of hopping to the original", async () => {
  const saved = await fixture(); store.update(saved.id, { state: "failed" });
  const e = store.execution(saved.id)!, chosen = await chooseSecond(e), original = e.terminal_id!;
  fake.mutate(s => { const a = s.servers.local!.agents.find(a => a.terminal_id === chosen.terminal_id)!; a.agent_session = null; a.interactive_ready = true; });
  await engine.refresh("local");
  expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "restoring", can_confirm_session: true, execution: { terminal_id: chosen.terminal_id } });
  expect((await conversations.continue(e)).mode).toBe("inspect");
  await expect(engine.retry(e)).rejects.toThrow("恢复原会话");
  expect(store.rounds(e.broadcast_id)).toHaveLength(1);
  await conversations.confirmSession(e, chosen.terminal_id);
  expect((await conversations.target(e))!.execution.terminal_id).toBe(chosen.terminal_id);
  expect(fake.server().prompts).toEqual([]);
  const round = await engine.retry(e);
  const retried = store.executions(e.broadcast_id).find(next => next.round_id === round.id)!;
  expect(retried).toMatchObject({ target_kind: "existing", terminal_id: chosen.terminal_id, session_value: session });
  // Changing the history preference must not erase physical confirmation of the old instance.
  await conversations.selectTarget(e, original);
  expect((await engine.retry(e)).id).toBe(round.id); // changing history cannot redirect an already submitted retry
  expect((await conversations.target(retried))!.execution.terminal_id).toBe(chosen.terminal_id);
  expect(store.execution(e.id)).toEqual(e);
  const physical = { ...e, state: "submitting" as const, pane_id: chosen.pane_id, terminal_id: chosen.terminal_id, workspace_id: chosen.workspace_id };
  expect((await conversations.target(physical))!.mode).toBe("reconnect");
  expect(store.continuation(continuationKey(e))!.terminal_id).toBe(original);
  await engine.refresh("local"); await engine.settle();
  expect(starts()).toEqual([]);
  expect(fake.server().prompts).toEqual([{ pane_id: chosen.pane_id, text: "must never be resent" }]);
  expect(store.execution(retried.id)).toMatchObject({ state: "sent", terminal_id: chosen.terminal_id, input_attempted: 1 });
});

for (const change of ["session", "provider", "terminal"] as const) {
  test(`a chosen instance whose ${change} changes never grants input to its replacement`, async () => {
    const e = await fixture(), chosen = await chooseSecond(e);
    fake.mutate(s => {
      const a = s.servers.local!.agents.find(a => a.terminal_id === chosen.terminal_id)!;
      if (change === "session") a.agent_session!.value = "different";
      if (change === "provider") a.agent = "pi";
      if (change === "terminal") { a.terminal_id = "replacement"; s.servers.local!.panes.find(p => p.pane_id === a.pane_id)!.terminal_id = "replacement"; }
    });
    if (change === "terminal") expect((await conversations.target(e))!.execution.terminal_id).toBe(e.terminal_id);
    else await expect(conversations.target(e)).rejects.toThrow("其他会话");
    await expect(conversations.confirmSession(e, chosen.terminal_id)).rejects.toThrow();
    expect(starts()).toEqual([]); expect(fake.server().prompts).toEqual([]);
  });
}

for (const status of ["ready", "launched", "uncertain"] as const) {
  test(`a ${status} selected terminal without session reports uses its current workspace label in every link`, async () => {
    const e = await fixture(), chosen = await chooseSecond(e), key = continuationKey(e);
    const binding = store.continuation(key)!;
    store.saveContinuation({ ...binding, status, workspace_label: "Old project" });
    fake.mutate(s => {
      const server = s.servers.local!, a = server.agents.find(a => a.terminal_id === chosen.terminal_id)!;
      a.agent_session = null; a.interactive_ready = true;
      server.workspaces.find(w => w.workspace_id === chosen.workspace_id)!.label = "Renamed project";
      server.workspaces.find(w => w.workspace_id === e.workspace_id)!.label = "Old project";
    });
    await engine.refresh("local");
    expect((await conversations.target(e))!.execution.workspace_label).toBe("Renamed project");
    const shown = snapshot(store, engine).broadcasts[0]!.executions[0]!;
    expect(new URLSearchParams(shown.web_link!.slice(1)).get("ws")).toBe(`${chosen.workspace_id}-${slugOf("Renamed project")}`);
    expect(shown.terminal_id).toBe(chosen.terminal_id);
    expect(store.execution(e.id)).toEqual(e);
  });
}

for (const marker of [null, 1] as const) {
  for (const hasPane of [false, true]) {
    test(`an abandoned unknown send (evidence=${marker}, pane=${hasPane}) never becomes a fresh-conversation retry`, async () => {
      const id = store.createBroadcast({ title: "uncertain", prompt: "possibly delivered", executions: [{ machine_id: "local", machine_label: "Local", target_kind: "new", agent_kind: "claude", cwd: "/src", pane_id: hasPane ? "closed" : null, terminal_id: hasPane ? "closed-terminal" : null }] });
      const e = store.executions(id)[0]!;
      store.update(e.id, { state: "sending", owner_pid: 2147483647 });
      store.update(e.id, { input_attempted: marker });
      expect(store.recoverAbandoned(() => false)).toBe(1);
      await engine.refresh("local");
      const failed = store.execution(e.id)!;
      expect(failed).toMatchObject({ seq_before: null, sent_at: null, input_attempted: marker });
      expect(continuationInfo(store, engine, failed).terminal_state).toBe("closed");
      expect(snapshot(store, engine).broadcasts[0]!.executions[0]!.can_retry).toBe(false);
      await expect(engine.retry(failed)).rejects.toThrow("恢复原会话");
      expect(store.rounds(id)).toHaveLength(1);
      expect(starts()).toEqual([]); expect(fake.server().prompts).toEqual([]);
    });
  }
}

for (const picker of [false, true]) {
  test(`an abandoned ${picker ? "picker" : "exact-session"} launch becomes inspectable and explicitly confirmable after restart`, async () => {
    let e = await fixture(); close(e);
    if (picker) { store.update(e.id, { session_kind: null, session_value: null }); e = store.execution(e.id)!; }
    const agent = fake.addAgent("local", "claude", "idle");
    fake.mutate(s => { s.servers.local!.agents[0]!.interactive_ready = true; });
    const key = continuationKey(e), lock = `continue:${key}`;
    store.saveContinuation({ key, pane_id: agent.pane_id, terminal_id: agent.terminal_id, workspace_id: agent.workspace_id,
      tab_id: agent.tab_id, workspace_label: "Recover", status: "starting", error: null, select_session: picker });
    store.acquireLock(lock, () => false, 300_000, 2147483647);
    await engine.refresh("local");
    expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "restoring", restore_pending: false, can_confirm_session: true, can_abandon_restore: true });
    expect(store.continuation(key)!.status).toBe("uncertain");
    const restarted = new Conversations(store, engine, () => {});
    expect((await restarted.continue(e)).mode).toBe("inspect");
    await restarted.confirmSession(e, agent.terminal_id);
    expect(continuationInfo(store, engine, e).terminal_state).toBe("live");
    expect(starts()).toEqual([]); expect(fake.server().prompts).toEqual([]);
    expect(store.execution(e.id)).toEqual(e);
  });
}

test("an active restoration retains its pending state until its owner releases the lock", async () => {
  const e = await fixture(); close(e);
  const agent = fake.addAgent("local", "claude", "idle");
  fake.mutate(s => { s.servers.local!.agents[0]!.interactive_ready = true; });
  const key = continuationKey(e), lock = `continue:${key}`;
  store.saveContinuation({ key, pane_id: agent.pane_id, terminal_id: agent.terminal_id, workspace_id: agent.workspace_id,
    tab_id: agent.tab_id, workspace_label: "Recover", status: "starting", error: null });
  store.acquireLock(lock, () => true, 300_000);
  await engine.refresh("local");
  expect(continuationInfo(store, engine, e)).toMatchObject({ restore_pending: true, can_confirm_session: false, can_abandon_restore: false });
  await expect(conversations.confirmSession(e, agent.terminal_id)).rejects.toThrow();
  store.releaseLock(lock);
  expect(continuationInfo(store, engine, e)).toMatchObject({ restore_pending: false, can_confirm_session: true });
});

test("an explicit live-instance selection survives the original instance reporting itself again", async () => {
  const e = await fixture();
  const original = fake.server().agents[0]!, originalPane = fake.server().panes[0]!;
  close(e);
  const chosen = fake.addAgent("local", "claude", "idle"), other = fake.addAgent("local", "claude", "idle");
  fake.mutate(s => { for (const a of s.servers.local!.agents) a.agent_session = { agent: "claude", kind: "id", source: "test", value: session }; });
  await conversations.selectTarget(e, chosen.terminal_id);
  fake.mutate(s => { s.servers.local!.agents.push(original); s.servers.local!.panes.push(originalPane); });
  expect((await conversations.target(e))!.execution.terminal_id).toBe(chosen.terminal_id);
  const restarted = new Conversations(store, engine, () => {});
  expect((await restarted.target(e))!.execution.terminal_id).toBe(chosen.terminal_id);
  expect((await restarted.options(e)).map(a => a.terminal_id)).toContain(other.terminal_id);
  expect(fake.server().prompts).toEqual([]);
});

test("a conversation reopened elsewhere uses its actual workspace name in external links", async () => {
  const e = await fixture(); close(e);
  const agent = fake.addAgent("local", "claude", "idle");
  fake.mutate(s => {
    s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value: session };
    s.servers.local!.workspaces.find(w => w.workspace_id === agent.workspace_id)!.label = "Moved project";
  });
  await engine.refresh("local");
  const info = continuationInfo(store, engine, e);
  expect(info.execution).toMatchObject({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, workspace_label: "Moved project" });
  expect((await conversations.target(e))!.execution.workspace_label).toBe("Moved project");
  const live = snapshot(store, engine).broadcasts[0]!.executions[0]!;
  expect(new URLSearchParams(live.web_link!.slice(1)).get("ws")).toBe(`${agent.workspace_id}-${slugOf("Moved project")}`);
  expect(store.execution(e.id)).toEqual(e);
});

test("a new agent that failed after pane creation retries once in a fresh terminal without replaying an uncertain send", async () => {
  fake.mutate(s => { s.servers.local!.failNext = { "agent start": ["usage"] }; });
  const id = store.createBroadcast({ title: "launch", prompt: "original instruction", executions: [{ machine_id: "local", machine_label: "Local", target_kind: "new", agent_kind: "claude", cwd: "/src", slot: 1 }] });
  const worker = new Engine(store, () => {}, { tickMs: 10, localPollMs: 20 });
  worker.submit(store.rounds(id)[0]!.id);
  try {
    await until(() => store.executions(id)[0]!.state === "failed");
    await worker.settle(); await worker.refresh("local");
    const failed = store.executions(id)[0]!;
    expect(failed.pane_id).not.toBeNull();
    // its shell is still there and shows why: the page keeps it visible, and offers the retry
    expect(snapshot(store, worker).broadcasts[0]!.executions[0]).toMatchObject({ terminal_state: "shell", can_retry: true, can_resume: false });
    const round = await worker.retry(failed);
    expect((await worker.retry(failed)).id).toBe(round.id);
    await until(() => store.executions(id).some(e => e.round_id === round.id && e.state === "sent"));
    const retried = store.executions(id).find(e => e.round_id === round.id)!;
    expect(retried.pane_id).not.toBe(failed.pane_id);
    expect(fake.server().panes.some(p => p.pane_id === failed.pane_id)).toBe(true);
    expect(fake.server().prompts).toEqual([{ pane_id: retried.pane_id!, text: "original instruction" }]);
    expect(store.execution(failed.id)).toEqual(failed);
    const uncertain = store.createBroadcast({ title: "uncertain", prompt: "do not replay", executions: [{ ...failed, pane_id: "missing", terminal_id: "missing" }] });
    const record = store.executions(uncertain)[0]!;
    store.update(record.id, { state: "failed", seq_before: 10 });
    await expect(worker.retry(record)).rejects.toThrow("恢复原会话");
    expect(store.executions(uncertain)).toHaveLength(1);
  } finally { worker.stop(); await worker.settle(); }
});

describe("continue a broadcast conversation", () => {
  test("a running original reconnects without starting a process or resending a prompt", async () => {
    const e = await fixture();
    expect((await conversations.continue(e)).mode).toBe("reconnect");
    expect(continuationInfo(store, engine, e).terminal_state).toBe("live");
    expect(starts()).toHaveLength(0);
    expect(fake.server().prompts).toEqual([]);
    expect(store.execution(e.id)).toEqual(e);
  });

  test("a closed Claude conversation resumes once, keeps its task result, and survives a dashboard restart", async () => {
    const e = await fixture(); close(e); await engine.refresh("local");
    expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "closed", can_resume: true });
    const results = await Promise.all([conversations.continue(e), conversations.continue(e)]);
    expect(results.map((r) => r.mode)).toEqual(["resumed", "resumed"]);
    expect(starts()).toHaveLength(1);
    expect(starts()[0]).toContain(`"--","--resume","${session}"`);
    expect(fake.server().prompts).toEqual([]);
    expect(store.execution(e.id)).toEqual(e);
    const resumed = continuationInfo(store, engine, e);
    expect(resumed.terminal_state).toBe("live");
    expect(resumed.execution.pane_id).not.toBe(e.pane_id);
    store.close(); store = new Store(fake.dbFile);
    engine = new Engine(store, () => {}, {});
    await engine.refreshMachines();
    conversations = new Conversations(store, engine, () => {}, async () => true, async () => ({ status: "none" }));
    expect((await conversations.continue(e)).mode).toBe("reconnect");
    expect(starts()).toHaveLength(1);
    expect(store.execution(e.id)).toEqual(e);
  });

  test("Codex restores the exact session on the original remote machine and directory", async () => {
    const e = await fixture("codex", "m-1"); close(e);
    expect((await conversations.continue(e)).mode).toBe("resumed");
    expect(starts()[0]).toStartWith("m-1 ");
    expect(starts()[0]).toContain(`"--","resume","${session}"`);
    expect(fake.server("m-1").agents[0]!.cwd).toBe(e.cwd!);
    expect(fake.server("local").agents).toHaveLength(0);
    expect(fake.server("m-1").prompts).toEqual([]);
  });

  test("the same conversation already reopened elsewhere is found without another launch", async () => {
    const e = await fixture(); close(e);
    const other = fake.addAgent("local", "claude");
    fake.mutate((s) => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "integration", value: session }; });
    expect((await conversations.continue(e)).mode).toBe("reconnect");
    expect((await conversations.target(e))?.execution.pane_id).toBe(other.pane_id);
    expect(starts()).toHaveLength(0);
  });

  test("reused pane IDs and a changed conversation never grant access to the replacement", async () => {
    const e = await fixture();
    fake.mutate((s) => {
      s.servers.local!.agents[0]!.terminal_id = "replacement";
      s.servers.local!.agents[0]!.agent_session!.value = "another-session";
      s.servers.local!.panes[0]!.terminal_id = "replacement";
    });
    expect(await conversations.target(e)).toBeNull();
    expect((await conversations.continue(e)).mode).toBe("resumed");
    expect((await conversations.target(e))?.execution.terminal_id).not.toBe("replacement");
    expect(fake.server().prompts).toEqual([]);
  });

  test("an unknown session on a still-running original and an unreachable machine never spawn a duplicate", async () => {
    const e = await fixture("codex", "m-1");
    fake.mutate((s) => { s.servers["m-1"]!.agents[0]!.agent_session = null; });
    await expect(conversations.continue(e)).rejects.toThrow("尚未报告会话标识");
    fake.mutate((s) => { s.servers["m-1"]!.unreachable = true; });
    await expect(conversations.continue(e)).rejects.toThrow("ssh");
    expect(starts()).toHaveLength(0);
  });

  test("a launch timeout leaves one inspectable terminal across retries and other broadcasts of that session", async () => {
    const e = await fixture(); close(e);
    fake.mutate((s) => { s.servers.local!.failNext = { "agent start": ["timeout"] }; });
    expect((await conversations.continue(e)).mode).toBe("inspect");
    const binding = store.continuation(continuationKey(e))!;
    expect(binding.status).toBe("uncertain");
    expect((await conversations.target(e))?.execution.pane_id).toBe(binding.pane_id);
    const otherBroadcast = store.createBroadcast({ title: "Another task in the same conversation", prompt: "also never resend", executions: [e] });
    const other = store.executions(otherBroadcast)[0]!;
    store.update(other.id, { state: "completed", session_kind: "id", session_value: session });
    const another = new Conversations(store, engine, () => {});
    expect((await another.continue(store.execution(other.id)!)).mode).toBe("inspect");
    expect(starts()).toHaveLength(1);
    expect(fake.server().prompts).toEqual([]);
  });

  test("missing, malformed and unsupported session refs do not silently create a fresh conversation", async () => {
    const e = await fixture(); close(e);
    for (const patch of [{ session_value: null }, { session_value: "--last" }, { agent_kind: "gemini" }, { cwd: null }]) {
      store.update(e.id, { session_value: session, agent_kind: "claude", cwd: e.cwd, ...patch });
      await expect(conversations.continue(store.execution(e.id)!)).rejects.toThrow();
    }
    expect(starts()).toHaveLength(0);
    expect(fake.server().workspaces).toHaveLength(1);
    expect(resumeArgs({ ...e, session_value: "$(touch /tmp/no)" })).toBeNull();
  });

  test("HTTP continuation is same-origin, authenticated and separate from rerunning the task", async () => {
    const e = await fixture(); close(e);
    web = startWebServer(store, { host: "127.0.0.1", port: 0, token: "test-secret", hosts: [] });
    await web.engine.refreshMachines();
    const base = web.url.replace(/\/$/, "");
    const url = `${base}/api/executions/${e.id}/continue`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer test-secret", origin: "https://other.example" } })).status).toBe(403);
    expect((await fetch(url, { headers: { authorization: "Bearer test-secret" } })).status).toBe(405);
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer test-secret", origin: base } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "resumed" });
    const state = await (await fetch(`${base}/api/state`, { headers: { authorization: "Bearer test-secret" } })).json() as any;
    expect(state.state.broadcasts[0].executions[0]).toMatchObject({ state: "completed", terminal_state: "live", finished_at: 456 });
    expect(state.state.broadcasts[0].executions[0].pane_id).not.toBe(e.pane_id);
    expect(fake.server().prompts).toEqual([]);
  });
});

test("Pi restores its saved transcript on the original remote machine", async () => {
  const e = await fixture("pi", "m-1");
  const path = "/home/remote/project sessions/original.jsonl";
  store.update(e.id, { session_kind: "path", session_value: path });
  const saved = store.execution(e.id)!;
  close(saved); await engine.refresh("m-1");
  expect(continuationInfo(store, engine, saved)).toMatchObject({ can_resume: true, resume_mode: "saved" });
  expect((await conversations.continue(saved)).mode).toBe("resumed");
  expect(starts()[0]).toContain(JSON.stringify(["--", "--session", path]).slice(1, -1));
  expect(starts()[0]).toStartWith("m-1 ");
  expect(fake.server("m-1").agents[0]!.cwd).toBe(e.cwd!);
  expect(fake.server("m-1").prompts).toEqual([]);
  expect(store.execution(e.id)).toEqual(saved);
  expect(resumeArgs({ ...saved, session_value: "relative.jsonl" })).toBeNull();
  expect(resumeArgs({ ...saved, session_value: "/tmp/a\n.jsonl" })).toBeNull();
});

test("old Pi broadcasts can explicitly open a session picker and reconnect to it across restarts", async () => {
  const e = await fixture("pi", "m-1");
  store.update(e.id, { session_kind: null, session_value: null });
  const saved = store.execution(e.id)!;
  close(saved); await engine.refresh("m-1");
  expect(continuationInfo(store, engine, saved)).toMatchObject({ terminal_state: "closed", can_resume: true, resume_mode: "choose" });
  await expect(conversations.continue(saved)).rejects.toThrow("手动选择");
  expect(starts()).toHaveLength(0);
  expect((await conversations.continue(saved, true)).mode).toBe("choose");
  expect(starts()).toHaveLength(1);
  expect(starts()[0]).toContain('"--","--resume"]');
  expect(starts()[0]).toContain('"--timeout","5000"');
  expect(fake.server("m-1").agents[0]!.cwd).toBe(saved.cwd!);
  const binding = store.continuation(continuationKey(saved))!;
  expect(binding.select_session).toBe(true);
  expect((await conversations.target(saved))?.execution.terminal_id).toBe(binding.terminal_id);
  const again = new Conversations(store, engine, () => {});
  expect((await again.continue(saved, true)).mode).toBe("inspect");
  expect(starts()).toHaveLength(1);
  expect(fake.server("m-1").prompts).toEqual([]);
  expect(store.execution(saved.id)).toEqual(saved);

  fake.mutate((s) => { s.servers["m-1"]!.agents[0]!.agent_session = { agent: "pi", kind: "path", source: "herdr:pi", value: "/home/remote/sessions/selected.jsonl" }; });
  expect((await conversations.target(saved))?.mode).toBe("reconnect");
  const selected = store.execution(saved.id)!;
  expect(selected.session_value).toBe("/home/remote/sessions/selected.jsonl");
  expect(selected.finished_at).toBe(saved.finished_at);
  fake.mutate((s) => { s.servers["m-1"]!.agents = []; s.servers["m-1"]!.panes = []; });
  expect((await conversations.continue(selected)).mode).toBe("resumed");
  expect(starts()).toHaveLength(2);
  expect(starts()[1]).toContain('"--session","/home/remote/sessions/selected.jsonl"');
});

test("session pickers work for Claude and Codex and never fall back to the most recent session", async () => {
  for (const kind of ["claude", "codex"]) {
    const e = await fixture(kind);
    store.update(e.id, { session_kind: null, session_value: null });
    const saved = store.execution(e.id)!; close(saved);
    expect((await conversations.continue(saved, true)).mode).toBe("choose");
    expect(starts().at(-1)).toContain(kind === "claude" ? '"--","--resume"]' : '"--","resume"]');
  }
  expect(starts().join("\n")).not.toContain("--last");
  expect(starts().join("\n")).not.toContain("--continue");
  expect(fake.server().prompts).toEqual([]);
});

test("a picker that is not idle yet remains inspectable without launching duplicates", async () => {
  const e = await fixture("pi"); close(e);
  store.update(e.id, { session_kind: null, session_value: null });
  const saved = store.execution(e.id)!;
  fake.mutate((s) => { s.servers.local!.failNext = { "agent start": ["timeout"] }; });
  expect((await conversations.continue(saved, true)).mode).toBe("choose");
  expect((await conversations.continue(saved, true)).mode).toBe("inspect");
  expect(starts()).toHaveLength(1);
  expect(continuationInfo(store, engine, saved).terminal_state).toBe("restoring");
});

test("an unsupported picker and an unavailable machine do not launch agents", async () => {
  const e = await fixture("gemini", "m-1"); close(e);
  store.update(e.id, { session_kind: null, session_value: null });
  await expect(conversations.continue(store.execution(e.id)!, true)).rejects.toThrow("暂不支持");
  store.update(e.id, { agent_kind: "pi" });
  fake.mutate((s) => { s.servers["m-1"]!.unreachable = true; });
  await expect(conversations.continue(store.execution(e.id)!, true)).rejects.toThrow("ssh");
  expect(starts()).toHaveLength(0);
});

test("HTTP exposes the legacy picker option and requires an explicit choice to launch it", async () => {
  const e = await fixture("pi"); close(e);
  store.update(e.id, { session_kind: null, session_value: null });
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
  await web.engine.refreshMachines(); await web.engine.refresh("local");
  const base = web.url.replace(/\/$/, "");
  const state = await (await fetch(`${base}/api/state`)).json() as any;
  expect(state.state.broadcasts[0].executions[0]).toMatchObject({ can_resume: true, resume_mode: "choose" });
  const url = `${base}/api/executions/${e.id}/continue`;
  expect((await fetch(url, { method: "POST", headers: { origin: base } })).status).toBe(400);
  const result = await fetch(url, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ choose_session: true }) });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ mode: "choose" });
  expect(starts()).toHaveLength(1);
});


test("missing Pi transcripts are rejected before opening a workspace or creating an empty conversation", async () => {
  const e = await fixture("pi"); close(e);
  store.update(e.id, { session_kind: "path", session_value: "/missing/old.jsonl" });
  const checked: string[][] = [];
  const checkedConversations = new Conversations(store, engine, () => {}, async (...args) => { checked.push(args); return false; });
  await expect(checkedConversations.continue(store.execution(e.id)!)).rejects.toThrow("不可读");
  expect(checked).toEqual([["local", "/missing/old.jsonl"]]);
  expect(starts()).toHaveLength(0);
  expect(fake.server().workspaces).toHaveLength(1);
});

test("Herdr's real shell-not-ready error retries in the same restore pane", async () => {
  const e = await fixture(); close(e);
  fake.mutate((s) => { s.servers.local!.failNext = { "agent start": ["agent_pane_busy"] }; });
  expect((await conversations.continue(e)).mode).toBe("resumed");
  expect(starts()).toHaveLength(2);
  expect(fake.server().agents).toHaveLength(1);
  expect(fake.server().workspaces).toHaveLength(2);
});

test("an old record with a unique history match opens the exact session and saves its identity", async () => {
  const e = await fixture("pi", "m-1"); close(e);
  store.update(e.id, { session_kind: null, session_value: null });
  const saved = store.execution(e.id)!;
  let searches = 0;
  const finder = new Conversations(store, engine, () => {}, async () => true, async (execution, broadcast) => {
    searches++;
    expect(execution.machine_id).toBe("m-1");
    expect(broadcast.prompt).toBe("must never be resent");
    return { status: "found", session: { kind: "path", value: "/home/remote/sessions/original.jsonl" } };
  });
  const results = await Promise.all([finder.continue(saved, true), finder.continue(saved, true)]);
  expect(results.map(r => r.mode)).toEqual(["resumed", "resumed"]);
  expect(searches).toBe(1);
  expect(starts()).toHaveLength(1);
  expect(starts()[0]).toContain('"--session","/home/remote/sessions/original.jsonl"');
  const remembered = store.execution(saved.id)!;
  expect(remembered.session_value).toBe("/home/remote/sessions/original.jsonl");
  expect(remembered.finished_at).toBe(saved.finished_at);
  expect(fake.server("m-1").prompts).toEqual([]);
  expect((await finder.continue(remembered)).mode).toBe("reconnect");
  expect(searches).toBe(1);
});

test("ambiguous history opens a picker and never stores an arbitrary identity", async () => {
  const e = await fixture("pi"); close(e);
  store.update(e.id, { session_kind: null, session_value: null });
  const finder = new Conversations(store, engine, () => {}, async () => true, async () => ({ status: "ambiguous" }));
  expect((await finder.continue(store.execution(e.id)!, true)).mode).toBe("choose");
  expect(store.execution(e.id)!.session_value).toBeNull();
  expect(starts()[0]).toContain('"--","--resume"]');
  expect(fake.server().prompts).toEqual([]);
});

test("a successful native restore without session reports is usable and does not stay in warning state", async () => {
  const e = await fixture("pi"); close(e);
  fake.mutate(s => { s.servers.local!.omitSessionReports = true; });
  expect((await conversations.continue(e)).mode).toBe("opened");
  expect(store.continuation(continuationKey(e))!.status).toBe("launched");
  expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "live", resume_reason: null });
  expect((await conversations.target(e))?.mode).toBe("reconnect");
  expect((await conversations.continue(e)).mode).toBe("reconnect");
  expect(starts()).toHaveLength(1);
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "pi", kind: "id", source: "integration", value: "different-session" }; });
  await expect(conversations.target(e)).rejects.toThrow("其他会话");
  fake.mutate(s => { const a = s.servers.local!.agents[0]!; a.agent_session = null; a.interactive_ready = true; });
  expect((await conversations.target(e))?.mode).toBe("inspect");
  await conversations.confirmSession(e, store.continuation(continuationKey(e))!.terminal_id);
  expect((await conversations.target(e))?.mode).toBe("reconnect");
});

test("legacy warnings clear only for a bound exact-session launch that is now interactively ready", async () => {
  const e = await fixture(); close(e);
  fake.mutate(s => { s.servers.local!.omitSessionReports = true; });
  await conversations.continue(e);
  const binding = store.continuation(continuationKey(e))!;
  // Simulate a pre-upgrade launch: it has no independent physical confirmation record.
  store.db.query("DELETE FROM continuations WHERE key = ?").run(terminalBindingKey(e, binding));
  store.saveContinuation({ ...binding, status: "uncertain", error: "启动命令已执行，尚未确认原会话标识；请检查终端提示" });
  expect((await conversations.target(e))?.mode).toBe("inspect");
  fake.mutate(s => { s.servers.local!.agents[0]!.interactive_ready = true; });
  expect((await conversations.target(e))?.mode).toBe("reconnect");
  expect(store.continuation(continuationKey(e))).toMatchObject({ status: "launched", error: null });
});


test("session discovery uses the selected round's prompt, not the first instruction", async () => {
  const original = await fixture("pi"); close(original);
  const round = store.createRound(original.broadcast_id, "second round instruction", [{ ...original, session_kind: null, session_value: null }]);
  const e = store.executions(original.broadcast_id).find(e => e.round_id === round.id)!;
  store.update(e.id, { state: "completed", sent_at: Date.now() });
  let discovered = false;
  const finder = new Conversations(store, engine, () => {}, async () => true, async (execution, broadcast) => {
    expect(execution.round_id).toBe(round.id);
    expect(broadcast.prompt).toBe("second round instruction");
    discovered = true;
    return { status: "none" };
  });
  expect((await finder.continue(store.execution(e.id)!, true)).mode).toBe("choose");
  expect(discovered).toBe(true);
  expect(fake.server().prompts).toEqual([]);
});

test("a manual picker selection without session reports needs explicit confirmation before follow-up", async () => {
  const old = await fixture("pi", "m-1"); close(old);
  store.update(old.id, { session_kind: null, session_value: null });
  const e = store.execution(old.id)!;
  await conversations.continue(e, true);
  const binding = store.continuation(continuationKey(e))!;
  await expect(conversations.confirmSession(e, binding.terminal_id)).rejects.toThrow("就绪");
  fake.mutate(s => { s.servers["m-1"]!.agents[0]!.interactive_ready = true; });
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
  await web.engine.refreshMachines(); await web.engine.refresh("m-1");
  const base = web.url.replace(/\/$/, "");
  const snapshot = async () => (await (await fetch(base + "/api/state")).json() as any).state.broadcasts.find((b: any) => b.id === e.broadcast_id).executions[0];
  expect(await snapshot()).toMatchObject({ can_follow_up: false, can_confirm_session: true, terminal_state: "restoring" });
  const url = base + `/api/executions/${e.id}/confirm-session`;
  const confirm = (terminal_id: string, origin = base) => fetch(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ terminal_id }) });
  expect((await fetch(url)).status).toBe(405);
  expect((await confirm(binding.terminal_id, "https://other.example")).status).toBe(403);
  expect((await confirm("stale-terminal")).status).toBe(400);
  expect((await confirm(binding.terminal_id)).status).toBe(200);
  expect(await snapshot()).toMatchObject({ can_follow_up: true, can_confirm_session: false, terminal_state: "live" });
  expect(store.continuation(continuationKey(e))).toMatchObject({ status: "launched", confirmed_session: true });
  expect(store.execution(e.id)).toEqual(e); // no invented session ID or changed historical result
  expect(fake.server("m-1").prompts).toEqual([]); // confirmation never types or submits anything
  expect((await new Conversations(store, engine, () => {}).target(e))?.mode).toBe("reconnect");
  const next = await fetch(base + `/api/broadcasts/${e.broadcast_id}/follow-up`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ prompt: "follow this selection", targets: [{ execution_id: e.id, terminal_id: binding.terminal_id }] }) });
  expect(next.status).toBe(200);
  expect(store.rounds(e.broadcast_id)).toHaveLength(2);
  expect(store.executions(e.broadcast_id)[1]).toMatchObject({ terminal_id: binding.terminal_id, pane_id: binding.pane_id });
});

test("manual confirmation cannot accept a replacement terminal or override a known session", async () => {
  const old = await fixture("pi"); close(old);
  store.update(old.id, { session_kind: null, session_value: null });
  const e = store.execution(old.id)!;
  await conversations.continue(e, true);
  const binding = store.continuation(continuationKey(e))!;
  fake.mutate(s => { const a = s.servers.local!.agents[0]!; a.interactive_ready = true; a.terminal_id = "replacement"; });
  await expect(conversations.confirmSession(e, binding.terminal_id)).rejects.toThrow();
  expect(store.continuation(continuationKey(e))?.confirmed_session).toBeUndefined();
  fake.mutate(s => { s.servers.local!.agents[0]!.terminal_id = binding.terminal_id; });
  store.update(e.id, { session_kind: "id", session_value: session });
  store.saveContinuation({ ...binding, key: continuationKey(store.execution(e.id)!) });
  await expect(conversations.confirmSession(store.execution(e.id)!, binding.terminal_id)).rejects.toThrow();
  expect(store.continuation(continuationKey(store.execution(e.id)!))?.confirmed_session).toBeUndefined();
});

test("exact restore timeout can be explicitly confirmed after readiness without session reports", async () => {
  const e = await fixture(); close(e);
  fake.mutate(s => { s.servers.local!.failNext = { "agent start": ["timeout"] }; });
  expect((await conversations.continue(e)).mode).toBe("inspect");
  const binding = store.continuation(continuationKey(e))!;
  fake.mutate(s => { s.servers.local!.agents.push({ pane_id: binding.pane_id, terminal_id: binding.terminal_id, workspace_id: binding.workspace_id, tab_id: binding.tab_id,
    cwd: e.cwd!, agent: "claude", name: "restored", agent_status: "idle", state_change_seq: 1, completion_seq: null, interactive_ready: true }); });
  await engine.refresh("local");
  expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "restoring", can_confirm_session: true });
  await conversations.confirmSession(e, binding.terminal_id);
  expect(continuationInfo(store, engine, e).terminal_state).toBe("live");
  expect(store.execution(e.id)).toEqual(e); expect(fake.server().prompts).toEqual([]); expect(starts()).toHaveLength(1);
  expect((await new Conversations(store, engine, () => {}).target(e))?.mode).toBe("reconnect");
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", value: "different", source: "test" }; });
  await expect(conversations.confirmSession(e, binding.terminal_id)).rejects.toThrow();
});

test("a failed restore has an explicit close-and-retry exit without closing the original conversation", async () => {
  const e = await fixture(); close(e);
  fake.mutate(s => { s.servers.local!.failNext = { "agent start": ["timeout"] }; });
  await conversations.continue(e);
  const binding = store.continuation(continuationKey(e))!;
  await conversations.abandon(e, binding.terminal_id);
  expect(fake.server().panes.some(p => p.terminal_id === binding.terminal_id)).toBe(false);
  expect((await conversations.continue(e)).mode).toBe("resumed");
  expect(starts()).toHaveLength(2); expect(store.execution(e.id)).toEqual(e); expect(fake.server().prompts).toEqual([]);
});

test("abandon never closes a replaced restore terminal", async () => {
  const e = await fixture(); close(e);
  fake.mutate(s => { s.servers.local!.failNext = { "agent start": ["timeout"] }; });
  await conversations.continue(e);
  const binding = store.continuation(continuationKey(e))!;
  fake.mutate(s => { s.servers.local!.panes.at(-1)!.terminal_id = "replacement"; });
  await expect(conversations.abandon(e, binding.terminal_id)).rejects.toThrow("已变化");
  expect(fake.calls().some(c => c.includes('["pane","close"'))).toBe(false);
});

test("retry after restoring a closed existing agent uses the restored terminal and preserves the old result", async () => {
  const old = await fixture(); store.update(old.id, { state: "lost", error: "exited" }); const e = store.execution(old.id)!; close(e);
  await expect(engine.retry(e)).rejects.toThrow("恢复原会话");
  await conversations.continue(e);
  const target = (await conversations.target(e))!.execution;
  const round = await engine.retry(e);
  const next = store.executions(e.broadcast_id).find(x => x.round_id === round.id)!;
  expect(next).toMatchObject({ pane_id: target.pane_id, terminal_id: target.terminal_id, target_kind: "existing", session_value: session });
  expect(next.terminal_id).not.toBe(e.terminal_id); expect(store.execution(e.id)).toEqual(e);
  await engine.refresh("local"); await engine.settle();
  expect(fake.server().prompts).toEqual([{ pane_id: target.pane_id!, text: "must never be resent" }]);
});

test("unstarted and identity-pending records do not masquerade as closed agents", async () => {
  const e = await fixture();
  expect(continuationInfo(store, engine, { ...e, pane_id: null, state: "queued" })).toMatchObject({ terminal_state: "not_started", can_resume: false });
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = null; }); await engine.refresh("local");
  expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "identity_pending", can_resume: false });
  expect(starts()).toHaveLength(0);
});

test("a manual history fallback explains why it could not restore automatically", async () => {
  const original = await fixture(); close(original); store.update(original.id, { session_value: null, session_kind: null }); const e = store.execution(original.id)!;
  const fallback = new Conversations(store, engine, () => {}, async () => true, async () => ({ status: "unavailable" }));
  const result = await fallback.continue(e, true);
  expect(result.message).toContain("无法完整读取");
  expect(store.continuation(continuationKey(e))!.discovery_note).toContain("无法完整读取");
  expect(fake.server().prompts).toEqual([]);
});

test("a newly created startup shell is inspectable and never presented as a closed conversation", async () => {
  const old = await fixture();
  fake.removeAgent("local", old.pane_id!);
  store.update(old.id, { state: "starting", session_kind: null, session_value: null });
  await engine.refresh("local");
  const e = store.execution(old.id)!;
  expect((await conversations.target(e))?.mode).toBe("inspect");
  expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "shell", can_resume: false });
  expect(starts()).toHaveLength(0);
});

test("disabled machines ask for configuration while transient outages recover automatically", async () => {
  const e = await fixture("claude", "m-1");
  fake.mutate(s => { s.machines[0]!.enabled = false; }); await engine.refreshMachines();
  expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "unreachable", requires_action: true });
  fake.mutate(s => { s.machines[0]!.enabled = true; s.servers["m-1"]!.unreachable = true; });
  await engine.refreshMachines(); await engine.refresh("m-1");
  expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "unreachable", requires_action: false });
});

test("automatic reconnect never discovers or starts closed history, even if a unique session is available", async () => {
  const original = await fixture(); close(original);
  store.update(original.id, { state: "sent", session_kind: null, session_value: null }); const e = store.execution(original.id)!;
  let discoveries = 0;
  const finder = new Conversations(store, engine, () => {}, async () => true, async () => {
    discoveries++; return { status: "found", session: { kind: "id", value: session } };
  });
  const results = await Promise.all([finder.continue(e, true, true), finder.continue(e, true, true)]);
  expect(results.map(r => r.mode)).toEqual(["manual", "manual"]);
  expect(discoveries).toBe(0); expect(starts()).toHaveLength(0); expect(store.execution(e.id)).toEqual(e);
  expect((await finder.continue(e, true)).mode).toBe("resumed");
  expect(discoveries).toBe(1); expect(starts()).toHaveLength(1); expect(fake.server().prompts).toEqual([]);
  expect(store.execution(e.id)).toMatchObject({ state: "sent", finished_at: e.finished_at, session_value: session });
});

test("a recovery terminal the user closed is not reopened automatically, only on request", async () => {
  const original = await fixture(); close(original);
  store.update(original.id, { state: "lost" }); const e = store.execution(original.id)!;
  await engine.refresh("local");
  expect(snapshot(store, engine).broadcasts[0]!.executions[0]).toMatchObject({ terminal_state: "closed", can_auto_resume: false });
  expect((await conversations.continue(e, true, true)).mode).toBe("manual");
  expect(starts()).toHaveLength(0);
  expect((await conversations.continue(e)).mode).toBe("resumed");
  expect(starts()).toHaveLength(1);
  // the user closes the restored terminal in Herdr
  const restored = store.continuation(continuationKey(e))!;
  fake.mutate(s => {
    const server = s.servers.local!;
    server.agents = server.agents.filter(a => a.pane_id !== restored.pane_id);
    server.panes = server.panes.filter(p => p.pane_id !== restored.pane_id);
  });
  await engine.refresh("local");
  expect(snapshot(store, engine).broadcasts[0]!.executions[0]).toMatchObject({ terminal_state: "closed", can_resume: true, can_auto_resume: false });
  expect((await conversations.continue(e, true, true)).mode).toBe("manual");
  expect(starts()).toHaveLength(1);
  expect((await conversations.continue(e)).mode).toBe("resumed");
  expect(starts()).toHaveLength(2); expect(fake.server().prompts).toEqual([]);
});

test("automatic recovery never opens a picker or guesses when history is not uniquely identified", async () => {
  const old = await fixture(); close(old); store.update(old.id, { state: "lost", session_kind: null, session_value: null });
  const e = store.execution(old.id)!;
  for (const status of ["none", "ambiguous", "unavailable"] as const) {
    const automatic = new Conversations(store, engine, () => {}, async () => true, async () => ({ status }));
    expect((await automatic.continue(e, true, true)).mode).toBe("manual");
  }
  expect(starts()).toHaveLength(0); expect(fake.server().prompts).toEqual([]);
  expect(fake.server().workspaces).toHaveLength(1); expect(store.execution(e.id)).toEqual(e);
});

test("explicitly choosing a live original conversation resolves duplicates and persists the chosen target", async () => {
  const e = await fixture(); close(e);
  const first = fake.addAgent("local", "claude", "idle", "first"), second = fake.addAgent("local", "claude", "idle", "second");
  const unrelated = fake.addAgent("local", "codex", "idle", "unrelated");
  fake.mutate(s => { for (const a of s.servers.local!.agents) a.agent_session = { agent: a.agent, kind: "id", source: "test", value: session }; });
  expect((await conversations.options(e)).map(x => x.terminal_id)).toEqual([first.terminal_id, second.terminal_id]);
  await expect(conversations.selectTarget(e, unrelated.terminal_id)).rejects.toThrow();
  await expect(conversations.target(e)).rejects.toThrow("多个终端");
  await conversations.selectTarget(e, second.terminal_id);
  expect((await conversations.target(e))?.execution.terminal_id).toBe(second.terminal_id);
  expect((await new Conversations(store, engine, () => {}).target(e))?.execution.terminal_id).toBe(second.terminal_id);
  expect(fake.server().prompts).toEqual([]); expect(store.execution(e.id)).toEqual(e);
  fake.mutate(s => { s.servers.local!.agents.find(a => a.terminal_id === first.terminal_id)!.agent_session!.value = "another"; });
  await expect(conversations.selectTarget(e, first.terminal_id)).rejects.toThrow();
});

for (const state of ["sent", "uncertain", "lost", "completed"] as const) test(`HTTP automatic reconnect leaves closed ${state} history alone until an explicit restore`, async () => {
  const old = await fixture(); close(old); store.update(old.id, { state });
  const e = store.execution(old.id)!;
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
  await web.engine.refreshMachines(); await web.engine.refresh("local");
  const base = web.url.replace(/\/$/, "");
  const post = (action = "recover", origin = base) => fetch(`${base}/api/executions/${e.id}/${action}`, { method: "POST", headers: { origin } });
  expect((await post("recover", "https://other.example")).status).toBe(403);
  for (let i = 0; i < 2; i++) {
    const shown = snapshot(store, web.engine).broadcasts[0]!.executions[0];
    expect(shown).toMatchObject({ terminal_state: "closed", can_auto_resume: false, can_resume: true });
    const response = await post(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "manual" });
  }
  expect(starts()).toHaveLength(0); expect(store.execution(e.id)).toEqual(e);
  const response = await post("continue"); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ mode: "resumed" });
  expect(starts()).toHaveLength(1); expect(fake.server().prompts).toEqual([]);
  expect(store.rounds(e.broadcast_id)).toHaveLength(1); expect(store.execution(e.id)).toEqual(e);
});

test("automatic reconnect finds the same live process after a transient machine outage", async () => {
  const e = await fixture("claude", "remote");
  fake.mutate(s => { s.servers.remote!.unreachable = true; }); await engine.refresh("remote");
  expect(continuationInfo(store, engine, e).terminal_state).toBe("unreachable");
  fake.mutate(s => { s.servers.remote!.unreachable = false; }); await engine.refresh("remote");
  expect((await conversations.continue(e, false, true)).mode).toBe("reconnect");
  expect(starts()).toHaveLength(0); expect(fake.server("remote").prompts).toEqual([]);
  expect(store.execution(e.id)).toEqual(e);
});

test("an unrecoverable transcript has a structured outcome instead of a raw connection error", async () => {
  const original = await fixture("pi"); close(original);
  store.update(original.id, { state: "lost", session_kind: "path", session_value: "/missing/history.jsonl" });
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
  await web.engine.refreshMachines(); const base = web.url.replace(/\/$/, "");
  const result = await fetch(`${base}/api/executions/${original.id}/continue`, { method: "POST", headers: { origin: base } });
  expect(await result.json()).toEqual({ ok: true, mode: "unavailable" });
  expect(starts()).toHaveLength(0); expect(fake.server().prompts).toEqual([]);
});

test("conversation choice endpoints reject another session, stale targets and cross-site writes", async () => {
  const e = await fixture(); close(e);
  const a = fake.addAgent("local", "claude", "idle"), rogue = fake.addAgent("local", "claude", "idle");
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value: session }; });
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
  await web.engine.refreshMachines(); const base = web.url.replace(/\/$/, "");
  const url = `${base}/api/executions/${e.id}/select-conversation`;
  const choose = (terminal_id: string, origin = base) => fetch(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ terminal_id }) });
  expect((await (await fetch(`${base}/api/executions/${e.id}/conversation-options`)).json() as any).options).toEqual([{ terminal_id: a.terminal_id, label: a.cwd }]);
  expect((await choose(a.terminal_id, "https://other.example")).status).toBe(403);
  expect((await choose(rogue.terminal_id)).status).toBe(400);
  expect((await choose(a.terminal_id)).status).toBe(200);
  expect((await conversations.target(e))?.execution.terminal_id).toBe(a.terminal_id);
  expect(fake.server().prompts).toEqual([]);
});

test("a ready original with permanently missing identity has an explicit confirmation path instead of reconnecting forever", async () => {
  const e = await fixture();
  fake.mutate(s => { const a = s.servers.local!.agents[0]!; a.agent_session = null; a.interactive_ready = true; });
  await engine.refresh("local");
  expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "restoring", can_confirm_session: true, restore_kind: "identity" });
  expect((await conversations.continue(e)).mode).toBe("inspect");
  await conversations.confirmSession(e, e.terminal_id);
  expect(continuationInfo(store, engine, e).terminal_state).toBe("live");
  expect(starts()).toHaveLength(0); expect(fake.server().prompts).toEqual([]); expect(store.execution(e.id)).toEqual(e);
});

test("a native missing-session failure becomes an unrecoverable outcome instead of a dead confirmation dialog", async () => {
  const e = await fixture(); close(e);
  fake.mutate(s => { s.servers.local!.failNext = { "agent start": ["session_not_found"] }; });
  expect((await conversations.continue(e)).mode).toBe("inspect");
  expect(continuationInfo(store, engine, e)).toMatchObject({ terminal_state: "closed", can_resume: false, restore_unavailable: true });
  expect(fake.server().prompts).toEqual([]); expect(store.execution(e.id)).toEqual(e);
});
