import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { detectWebUi, snapshot, startWebServer } from "../src/web/server.ts";
import { FakeHerdr, until } from "./helpers.ts";

let fake: FakeHerdr;
let store: Store;
let web: ReturnType<typeof startWebServer>;
let base: string;

function start(token: string | null = null) {
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token, hosts: [] }, { tickMs: 30, localPollMs: 60, remotePollMs: 60 });
  base = `http://127.0.0.1:${web.server.port}`;
}

/** These action fixtures represent history whose identity was captured at send time. */
function identifyHistory(broadcastId: number) {
  for (const e of store.executions(broadcastId)) {
    let value = "";
    fake.mutate(s => {
      const a = s.servers[e.machine_id]!.agents.find(a => a.terminal_id === e.terminal_id)!;
      value = a.agent_session?.value || crypto.randomUUID();
      a.agent_session = { agent: a.agent, kind: "id", source: "test", value };
    });
    store.update(e.id, { session_kind: "id", session_value: value });
  }
}

/** A request as the page itself sends it: same origin. */
const send = (path: string, body: unknown, method = "POST") =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });

beforeEach(() => {
  fake = new FakeHerdr();
  store = new Store(fake.dbFile);
});

afterEach(async () => {
  await web?.stop();
  store.close();
  fake.cleanup();
});

describe("web page", () => {
  test("card rename changes Herdr's real agent name on its machine and keeps shared records in sync", async () => {
    fake.addMachine("m-1", "remote");
    const agent = fake.addAgent("m-1", "pi", "done", "bc10-pi-1");
    const input = { machine_id: "m-1", machine_label: "remote", target_kind: "existing" as const, agent_kind: "pi", agent_name: agent.name, pane_id: agent.pane_id, terminal_id: agent.terminal_id };
    const first = store.createBroadcast({ title: "one", prompt: "never resend", executions: [input] });
    const second = store.createBroadcast({ title: "two", prompt: "never resend either", executions: [input] });
    identifyHistory(first); identifyHistory(second);
    const runs = [store.executions(first)[0]!, store.executions(second)[0]!];
    for (const e of runs) store.update(e.id, { state: "completed", finished_at: 123 });
    start();
    await until(() => web.engine.machine("m-1") !== undefined);
    const unwatch = web.engine.watch("m-1");
    const response = await send(`/api/executions/${runs[0]!.id}/rename`, { name: "reviewer", terminal_id: agent.terminal_id });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "reviewer" });
    expect(fake.server("m-1").agents[0]!.name).toBe("reviewer");
    expect(fake.calls().some((c) => c.startsWith('m-1 ["agent","rename",') && c.includes('"reviewer"'))).toBe(true);
    for (const e of runs) expect(store.execution(e.id)).toMatchObject({ agent_name: "reviewer", state: "completed", finished_at: 123 });
    expect(fake.server("m-1").prompts).toEqual([]);
    await until(() => snapshot(store, web.engine).broadcasts.every((b) => b.executions[0]!.agent_name === "reviewer"));
    // A name changed in another client is read back from Herdr, not overridden by the stored name.
    fake.mutate((s) => { s.servers["m-1"]!.agents[0]!.name = "frontend"; });
    await until(() => snapshot(store, web.engine).broadcasts.every((b) => b.executions[0]!.agent_name === "frontend"));
    unwatch();
  });

  test("card rename validates names, rejects duplicates and never renames a stale or replaced terminal", async () => {
    const agent = fake.addAgent("local", "pi", "done", "original");
    fake.addAgent("local", "pi", "done", "taken");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [{ machine_id: "local", machine_label: "local", target_kind: "existing", agent_kind: "pi", agent_name: "original", pane_id: agent.pane_id, terminal_id: agent.terminal_id }] });
  identifyHistory(id);
    const e = store.executions(id)[0]!;
    store.update(e.id, { state: "completed" });
    start();
    const path = `/api/executions/${e.id}/rename`;
    expect((await fetch(`${base}${path}`)).status).toBe(405);
    expect((await fetch(`${base}${path}`, { method: "POST", headers: { origin: "https://elsewhere.example", "content-type": "application/json" }, body: JSON.stringify({ name: "changed", terminal_id: agent.terminal_id }) })).status).toBe(403);
    for (const name of ["", "中文", "Upper", "a b", "x".repeat(33), "$(id)"]) expect((await send(path, { name, terminal_id: agent.terminal_id })).status).toBe(400);
    expect(fake.calls().some((c) => c.includes('["agent","rename"'))).toBe(false);
    const duplicate = await send(path, { name: "taken", terminal_id: agent.terminal_id });
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json() as any).error.message).toContain("已被其他 agent 使用");
    expect((await send(path, { name: "changed", terminal_id: "old-terminal" })).status).toBe(409);
    expect(fake.server().agents[0]!.name).toBe("original");
    expect(store.execution(e.id)!.agent_name).toBe("original");
    fake.mutate((s) => {
      s.servers.local!.agents[0]!.terminal_id = "replacement";
      s.servers.local!.agents[0]!.agent_session!.value = "replacement-session";
      s.servers.local!.panes[0]!.terminal_id = "replacement";
    });
    expect((await send(path, { name: "changed", terminal_id: agent.terminal_id })).status).toBe(400);
    expect(fake.server().agents[0]!.name).toBe("original");
  });

  test("serves the page and its script under a strict policy", async () => {
    start();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<script src="/page.js">');
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self';");
    expect((await fetch(`${base}/page.js`)).status).toBe(200);
  });

  test("a broadcast from the form reaches an idle agent", async () => {
    const agent = fake.addAgent("local", "claude");
    start();
    const response = await send("/api/broadcasts", { prompt: "从网页发的", targets: [{ machine: "local", pane: agent.pane_id, terminal_id: agent.terminal_id }] });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: number };
    await until(() => store.executions(id)[0]?.state === "sent", 8000, "sent");
    expect(fake.server().prompts).toEqual([{ pane_id: agent.pane_id, text: "从网页发的" }]);

    const state = (await (await fetch(`${base}/api/state`)).json()) as { state: { broadcasts: { id: number; executions: { web_link: string }[] }[] } };
    expect(state.state.broadcasts[0]!.id).toBe(id);
    expect(state.state.broadcasts[0]!.executions[0]!.web_link).toContain(`pane=${encodeURIComponent(agent.pane_id)}`);
  });

  test("new broadcast creation rejects replaced terminals, agent kinds and known conversations before saving anything", async () => {
    const agent = fake.addAgent("local", "claude");
    const value = "01234567-1234-4567-89ab-0123456789ab";
    fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value }; });
    start();
    const selected = { machine: "local", pane: agent.pane_id, terminal_id: agent.terminal_id, agent_kind: "claude", session_kind: "id", session_value: value };
    for (const choice of [
      { machine: "local", pane: agent.pane_id },
      { ...selected, terminal_id: "old-terminal" }, { ...selected, agent_kind: "codex" },
      { ...selected, session_kind: "path" }, { ...selected, session_value: "old-session" },
    ]) {
      expect((await send("/api/broadcasts", { prompt: "never send this", targets: [choice] })).status).toBe(400);
      expect(store.listBroadcasts()).toEqual([]);
      expect(fake.server().prompts).toEqual([]);
    }
    // The UI exposes the same identity that its checkbox must preserve until submission.
    const state = await (await fetch(`${base}/api/state`)).json() as any;
    expect(state.agents[0].agents[0]).toMatchObject({ terminal_id: agent.terminal_id, session_kind: "id", session_value: value });
    expect((await send("/api/broadcasts", { prompt: "send to the chosen conversation", targets: [selected] })).status).toBe(200);
    await until(() => store.executions(1)[0]?.state === "sent");
    expect(fake.server().prompts).toEqual([{ pane_id: agent.pane_id, text: "send to the chosen conversation" }]);
  });

  test("new agents in the form are checked: a remote folder must be absolute or ~", async () => {
    fake.addMachine("m-1", "gpu-box");
    start();
    await until(() => web.engine.machines.length === 2, 8000, "machines");
    const response = await send("/api/broadcasts", { prompt: "p", new: [{ machine: "m-1", kind: "codex", cwd: "repo", count: 1 }] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("绝对路径");
  });

  test("a new local agent needs a folder that exists", async () => {
    start();
    const missing = await send("/api/broadcasts", { prompt: "p", new: [{ machine: "local", kind: "claude", cwd: "/no/such/folder/here", count: 1 }] });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toContain("本机没有这个目录");
    const plain = mkdtempSync(join(tmpdir(), "bcast-plain-"));
    try {
      const dirs = (await (await fetch(`${base}/api/dirs?machine=local&q=${encodeURIComponent(plain)}`)).json()) as { target: { exists: boolean } };
      expect(dirs.target).toEqual({ exists: true });
      const sent = await send("/api/broadcasts", { prompt: "p", new: [{ machine: "local", kind: "claude", cwd: plain, count: 1 }] });
      expect(sent.status).toBe(200);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("machines: renamed, disabled and removed from the page; their state read from herdr", async () => {
    fake.addMachine("m-1", "gpu-box");
    start();
    await until(() => web.engine.machines.length === 2, 8000, "machines");
    expect((await send("/api/machines/m-1/rename", { label: "训练机" })).status).toBe(200);
    expect((await send("/api/machines/m-1/disable", {})).status).toBe(200);
    expect(web.engine.machine("m-1")).toMatchObject({ label: "训练机", enabled: false });
    const health = (await (await fetch(`${base}/api/machines/health?fresh=1`)).json()) as { health: Record<string, { ok: boolean }> };
    expect(health.health["m-1"]!.ok).toBe(true);
    expect((await send("/api/machines/local", {}, "DELETE")).status).toBe(404);
    expect((await send("/api/machines/m-1", {}, "DELETE")).status).toBe(200);
    expect(web.engine.machine("m-1")).toBeUndefined();
  });

  test("adding a machine is for this computer's own browser: a proxied request is refused before anything runs", async () => {
    start();
    const proxied = await fetch(`${base}/api/ssh/check`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin", "x-forwarded-for": "100.64.0.9" },
      body: JSON.stringify({ target: "qi@box" }),
    });
    expect(proxied.status).toBe(403);
    expect((await (await fetch(`${base}/api/config`, { headers: { "x-forwarded-for": "100.64.0.9" } })).json() as { local: boolean }).local).toBe(false);
    expect((await (await fetch(`${base}/api/config`)).json() as { local: boolean }).local).toBe(true);
    // an address a shell could misread never reaches ssh
    const bad = await send("/api/ssh/check", { target: "-oProxyCommand=touch /tmp/x" });
    expect(bad.status).toBe(400);
  });

  test("PCs added only in herdr-web-ui are offered to this computer's browser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcast-webui-"));
    const before = process.env.HERDR_WEB_STATE_DIR;
    process.env.HERDR_WEB_STATE_DIR = dir;
    try {
      writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id: "a", name: "rl", target: { destination: "root@10.9.9.9", identity_file: "/keys/rl.pem" }, enabled: true }]));
      start();
      const offered = (await (await fetch(`${base}/api/machines/web-ui`)).json()) as { machines: { target: string; key: string }[] };
      expect(offered.machines).toMatchObject([{ target: "root@10.9.9.9", key: "/keys/rl.pem" }]);
      expect((await fetch(`${base}/api/machines/web-ui`, { headers: { "x-forwarded-for": "100.64.0.9" } })).status).toBe(403);
    } finally {
      if (before === undefined) delete process.env.HERDR_WEB_STATE_DIR;
      else process.env.HERDR_WEB_STATE_DIR = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a server without Herdr: installing it is approved on the page, other questions are asked there", async () => {
    fake.remote("root@10.9.9.9", { install: true, stopServer: true });
    start();
    type Job = { id: string; state: string; question: { kind: string } | null; output: string };
    const read = async (id: string) => ((await (await fetch(`${base}/api/machines/add/${id}`)).json()) as { job: Job }).job;
    const started = (await (await send("/api/machines/add", { target: "root@10.9.9.9", label: "rl", install: true })).json()) as { job: Job };
    let job = started.job;
    // the install question is answered by the approval; stopping the server there is not
    for (let i = 0; i < 100 && job.state === "running"; i += 1) { await Bun.sleep(50); job = await read(job.id); }
    expect(job).toMatchObject({ state: "question", question: { kind: "server" } });
    expect(job.output).toContain("installed remote herdr");
    expect((await send(`/api/machines/add/${job.id}/answer`, { yes: true })).status).toBe(200);
    for (let i = 0; i < 100 && job.state !== "done"; i += 1) { await Bun.sleep(50); job = await read(job.id); }
    expect(job.state).toBe("done");
    expect(fake.read().machines).toMatchObject([{ label: "rl", target: "root@10.9.9.9", session: "default" }]);
    await until(() => web.engine.machines.length === 2, 8000, "machine shows");
  });

  test("declining the install leaves nothing saved", async () => {
    fake.remote("root@10.9.9.8", { install: true });
    start();
    type Job = { id: string; state: string; question: { kind: string } | null };
    let job = ((await (await send("/api/machines/add", { target: "root@10.9.9.8" })).json()) as { job: Job }).job;
    for (let i = 0; i < 100 && job.state === "running"; i += 1) { await Bun.sleep(50); job = ((await (await fetch(`${base}/api/machines/add/${job.id}`)).json()) as { job: Job }).job; }
    expect(job).toMatchObject({ state: "question", question: { kind: "install" } });
    await send(`/api/machines/add/${job.id}/answer`, { yes: false });
    for (let i = 0; i < 100 && job.state !== "failed"; i += 1) { await Bun.sleep(50); job = ((await (await fetch(`${base}/api/machines/add/${job.id}`)).json()) as { job: Job }).job; }
    expect(job.state).toBe("failed");
    expect(fake.read().machines).toEqual([]);
  });

  test("an agent's card talks to it: keystrokes as typed, a message as a prompt, keys only from the list", async () => {
    const agent = fake.addAgent("local", "claude");
    fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value: crypto.randomUUID() }; });
    start();
    const { id } = (await (await send("/api/broadcasts", { prompt: "第一轮", targets: [{ machine: "local", pane: agent.pane_id, terminal_id: agent.terminal_id }] })).json()) as { id: number };
    await until(() => store.executions(id)[0]?.state === "sent", 8000, "sent");
    const exec = store.executions(id)[0]!.id;
    expect((await send(`/api/executions/${exec}/input`, { text: "接着做第二步", submit: true })).status).toBe(200);
    expect(fake.server().prompts.map((p) => p.text)).toEqual(["第一轮", "接着做第二步"]);
    expect((await send(`/api/executions/${exec}/input`, { keys: ["down", "enter"] })).status).toBe(200);
    // what is typed in the page's terminal goes in as it is
    expect((await send(`/api/executions/${exec}/input`, { raw: "y\r" })).status).toBe(200);
    expect(fake.server().typed?.at(-1)).toEqual({ pane_id: agent.pane_id, text: "y\r" });
    const refused = await send(`/api/executions/${exec}/input`, { keys: ["f13"] });
    expect(refused.status).toBe(400);
    // focusing Herdr is for this computer's own browser
    const proxied = await fetch(`${base}/api/executions/${exec}/focus`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin", "x-forwarded-for": "100.64.0.9" } });
    expect(proxied.status).toBe(403);
  });

  test("other sites cannot post, and unknown Host names are refused", async () => {
    start();
    const cross = await fetch(`${base}/api/broadcasts`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: "{}" });
    expect(cross.status).toBe(403);
    const noOrigin = await fetch(`${base}/api/broadcasts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noOrigin.status).toBe(403);
    const rebound = await fetch(`${base}/api/state`, { headers: { host: "attacker.example" } });
    expect(rebound.status).toBe(421);
  });

  test("with a token, nothing works without it; ?token= once sets a cookie", async () => {
    start("s3cret");
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    const login = await fetch(`${base}/?token=s3cret`, { redirect: "manual" });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${base}/api/state`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/state`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  test("retry: a failed or lost execution goes out again, a completed one does not", async () => {
    const agent = fake.addAgent("local", "claude", "working");
    const id = store.createBroadcast({ title: "t", prompt: "again", executions: [
      { machine_id: "local", machine_label: "本机", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id },
      { machine_id: "local", machine_label: "本机", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id },
    ] });
    const [lost, done] = store.executions(id);
    store.update(lost!.id, { state: "lost", error: "agent 在完成前退出了" });
    store.update(done!.id, { state: "completed" });
    start();
    expect((await send(`/api/executions/${done!.id}/retry`, {})).status).toBe(400);
    expect((await send(`/api/executions/${lost!.id}/retry`, {})).status).toBe(200);
    expect(store.execution(lost!.id)!.state).toBe("lost");
    expect(store.execution(lost!.id)!.error).toBe("agent 在完成前退出了");
    expect(store.rounds(id)).toHaveLength(2);
    await until(() => store.executions(id).at(-1)!.state === "sent");
  });

  test("the page cannot type into an agent: there is no keys endpoint", async () => {
    const agent = fake.addAgent("local", "claude", "blocked");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id }] });
    start();
    const exec = store.executions(id)[0]!.id;
    expect((await send(`/api/executions/${exec}/keys`, { keys: ["1"] })).status).toBe(404);
    expect(fake.calls().some((c) => c.includes('"send-keys"'))).toBe(false);
  });

  test("the selected agent's screen is read through herdr, with the history above it", async () => {
    const agent = fake.addAgent("local", "claude");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id }] });
    start();
    const response = await fetch(`${base}/api/executions/${store.executions(id)[0]!.id}/screen`);
    expect(((await response.json()) as { text: string }).text).toContain("fake output");
    // a TUI that cleared its screen on a resize left its conversation in the history
    expect(fake.calls().some((c) => c.includes('"--source","recent-unwrapped"') && c.includes('"--format","ansi"'))).toBe(true);
  });

  test("without herdr-web-ui, an agent is shown in Herdr itself", async () => {
    const agent = fake.addAgent("local", "claude");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id }] });
    start();
    const response = await send(`/api/executions/${store.executions(id)[0]!.id}/focus`, {});
    expect(response.status).toBe(200);
    expect(fake.calls().some((c) => c.includes(`"agent","focus","${agent.pane_id}"`))).toBe(true);
  });

  test("the page learns whether herdr-web-ui is there", async () => {
    start();
    const state = (await (await fetch(`${base}/api/state`)).json()) as { webUi: { installed: boolean; running: boolean } };
    expect(typeof state.webUi.installed).toBe("boolean");
    expect(typeof state.webUi.running).toBe("boolean");
  });

  test("detection: not installed and nothing answering", async () => {
    // the fake herdr knows no plugin list, and nothing listens on this port
    expect(await detectWebUi("http://127.0.0.1:9/")).toEqual({ installed: false, running: false });
  });
});

test("follow-up sends only to selected existing agents and leaves the original results intact", async () => {
  const one = fake.addAgent("local", "pi", "idle");
  const two = fake.addAgent("local", "claude", "idle");
  const id = store.createBroadcast({ title: "Original", prompt: "original", executions: [one, two].map(a => ({ machine_id: "local", machine_label: "Local", target_kind: "existing", agent_kind: a.agent, pane_id: a.pane_id, terminal_id: a.terminal_id })) });
  identifyHistory(id);
  for (const e of store.executions(id)) store.update(e.id, { state: "completed" });
  const original = store.executions(id);
  start(); await web.engine.refreshMachines(); await web.engine.refresh("local");
  const choice = { execution_id: original[1]!.id, terminal_id: two.terminal_id };
  const response = await send(`/api/broadcasts/${id}/follow-up`, { prompt: "continue this conversation", targets: [choice, choice] });
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  expect(result.executions).toBe(1);
  expect(result.id).toBe(id);
  expect(result.round_number).toBe(2);
  expect(store.listBroadcasts()).toHaveLength(1);
  expect(store.executions(result.id).find(e => e.round_id === result.round_id)).toMatchObject({ pane_id: two.pane_id, terminal_id: two.terminal_id, target_kind: "existing" });
  await until(() => fake.server().prompts.length === 1);
  expect(fake.server().prompts).toEqual([{ pane_id: two.pane_id, text: "continue this conversation" }]);
  expect(store.executions(id).filter(e => e.round_id === original[0]!.round_id)).toEqual(original);
  const b = snapshot(store, web.engine).broadcasts[0]!;
  expect(b.rounds.map(r => [r.number, r.prompt, r.total])).toEqual([[1, "original", 2], [2, "continue this conversation", 1]]);
  expect(b.rounds[0]!.counts).toEqual({ completed: 2 });
  expect(fake.calls().some(line => line.includes('["agent","start"'))).toBe(false);
});

test("follow-up validates the entire selection before sending, rejects stale terminals and cross-site requests", async () => {
  const one = fake.addAgent("local", "pi", "idle");
  const two = fake.addAgent("local", "pi", "idle");
  const id = store.createBroadcast({ title: "Original", prompt: "original", executions: [one, two].map(a => ({ machine_id: "local", machine_label: "Local", target_kind: "existing", agent_kind: a.agent, pane_id: a.pane_id, terminal_id: a.terminal_id })) });
  identifyHistory(id);
  for (const e of store.executions(id)) store.update(e.id, { state: "completed" });
  const executions = store.executions(id);
  start(); await web.engine.refreshMachines();
  const path = `/api/broadcasts/${id}/follow-up`;
  const good = { execution_id: executions[0]!.id, terminal_id: one.terminal_id };
  expect((await fetch(base + path)).status).toBe(405);
  expect((await fetch(base + path, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ prompt: "p", targets: [good] }) })).status).toBe(403);
  for (const body of [
    { prompt: "", targets: [good] }, { prompt: "p", targets: [] },
    { prompt: "p", targets: [good, { execution_id: 99999, terminal_id: "unknown" }] },
    { prompt: "p", targets: [good, { execution_id: executions[1]!.id, terminal_id: "stale" }] },
  ]) expect((await send(path, body)).status).toBe(400);
  fake.removeAgent("local", two.pane_id);
  expect((await send(path, { prompt: "p", targets: [good, { execution_id: executions[1]!.id, terminal_id: two.terminal_id }] })).status).toBe(400);
  expect(store.listBroadcasts()).toHaveLength(1);
  expect(store.rounds(id)).toHaveLength(1);
  expect(fake.server().prompts).toEqual([]);
});

test("a busy remote agent receives a follow-up immediately", async () => {
  fake.addMachine("m-1", "Remote");
  const a = fake.addAgent("m-1", "pi", "working");
  const id = store.createBroadcast({ title: "Original", prompt: "original", executions: [{ machine_id: "m-1", machine_label: "Remote", target_kind: "existing", agent_kind: a.agent, pane_id: a.pane_id, terminal_id: a.terminal_id }] });
  identifyHistory(id);
  const e = store.executions(id)[0]!; store.update(e.id, { state: "completed" });
  start(); await web.engine.refreshMachines();
  const response = await send(`/api/broadcasts/${id}/follow-up`, { prompt: "next task", targets: [{ execution_id: e.id, terminal_id: a.terminal_id }] });
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  await until(() => store.executions(result.id).find(e => e.round_id === result.round_id)!.state === "sent");
  expect(fake.server("m-1").agents[0]!.agent_status).toBe("working");
  await until(() => fake.server("m-1").prompts.length === 1);
  expect(fake.server("m-1").prompts[0]!.text).toBe("next task");
  expect(fake.server().prompts).toEqual([]);
});

test("follow-up uses a restored instance and retains its known session when Herdr omits session reports", async () => {
  const a = fake.addAgent("local", "pi", "idle", "restored");
  const session = "01234567-1234-4567-89ab-0123456789ab";
  const id = store.createBroadcast({ title: "Original", prompt: "original", executions: [{ machine_id: "local", machine_label: "Local", target_kind: "existing", agent_kind: "pi", pane_id: "old:p1", terminal_id: "old-terminal" }] });
  const e = store.executions(id)[0]!;
  store.update(e.id, { state: "completed", session_kind: "id", session_value: session });
  store.saveContinuation({ key: JSON.stringify(["local", "pi", "id", session]), pane_id: a.pane_id, terminal_id: a.terminal_id, workspace_id: a.workspace_id, tab_id: a.tab_id, workspace_label: "Restored", status: "launched", error: null });
  start(); await web.engine.refreshMachines(); await web.engine.refresh("local");
  expect(snapshot(store, web.engine).broadcasts[0]!.executions[0]).toMatchObject({ can_follow_up: true, terminal_state: "live", terminal_id: a.terminal_id });
  const response = await send(`/api/broadcasts/${id}/follow-up`, { prompt: "keep the context", targets: [{ execution_id: e.id, terminal_id: a.terminal_id }] });
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  await until(() => fake.server().prompts.length === 1);
  expect(store.executions(result.id).find(e => e.round_id === result.round_id)).toMatchObject({ pane_id: a.pane_id, terminal_id: a.terminal_id, session_kind: "id", session_value: session });
  expect(fake.server().prompts[0]!.pane_id).toBe(a.pane_id);
});

test("interrupt API rejects stale identity and cross-site requests without changing delivery", async () => {
  const a = fake.addAgent("local", "claude", "working");
  const id = store.createBroadcast({ title: "interrupt", prompt: "p", executions: [{ machine_id: "local", machine_label: "local", target_kind: "existing", agent_kind: "claude", pane_id: a.pane_id, terminal_id: a.terminal_id }] });
  identifyHistory(id);
  const e = store.executions(id)[0]!; store.update(e.id, { state: "working", saw_working: 1, seq_before: 10 }); start();
  const url = `/api/executions/${e.id}/interrupt`;
  expect((await fetch(base + url, { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body: JSON.stringify({ terminal_id: a.terminal_id }) })).status).toBe(403);
  expect((await send(url, { terminal_id: "stale" })).status).toBe(400);
  expect(fake.calls().some(c => c.includes('"ctrl+c"'))).toBe(false);
  expect((await send(url, { terminal_id: a.terminal_id })).status).toBe(200);
  expect(store.execution(e.id)!.state).toBe("sent");
  fake.setStatus("local", a.pane_id, "idle");
  await web.engine.refresh("local");
  expect(store.execution(e.id)!.state).toBe("sent");
  expect(fake.calls().filter(c => c.includes('"ctrl+c"'))).toHaveLength(1);
});

test("unknown delivery history cannot follow up, retry or interrupt a later session until explicitly confirmed", async () => {
  const a = fake.addAgent("local", "claude", "idle"); start();
  const response = await send("/api/broadcasts", { prompt: "original", targets: [{ machine: "local", pane: a.pane_id, terminal_id: a.terminal_id }] });
  const { id } = await response.json() as { id: number };
  await until(() => store.executions(id)[0]?.state === "sent");
  const original = store.executions(id)[0]!;
  expect(original.session_value).toBeNull();
  const value = crypto.randomUUID();
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value }; });
  store.update(original.id, { state: "uncertain" });
  await web.engine.refresh("local");
  const path = `/api/executions/${original.id}`;
  const follow = { prompt: "follow up", targets: [{ execution_id: original.id, terminal_id: a.terminal_id }] };
  expect((await send(`/api/broadcasts/${id}/follow-up`, follow)).status).toBe(400);
  expect((await send(`${path}/retry`, {})).status).toBe(400);
  expect((await send(`${path}/interrupt`, { terminal_id: a.terminal_id })).status).toBe(400);
  expect(store.execution(original.id)!.session_value).toBeNull(); expect(store.rounds(id)).toHaveLength(1);
  expect(fake.server().prompts).toEqual([{ pane_id: a.pane_id, text: "original" }]);
  expect(fake.calls().some(c => c.includes('"ctrl+c"'))).toBe(false);
  expect((await send(`${path}/confirm-session`, { terminal_id: a.terminal_id })).status).toBe(200);
  expect(store.execution(original.id)).toMatchObject({ state: "uncertain", session_value: value });
  expect((await send(`/api/broadcasts/${id}/follow-up`, follow)).status).toBe(200);
  await until(() => store.executions(id)[1]?.state === "sent");
  expect(fake.server().prompts.map(p => p.text)).toEqual(["original", "follow up"]);
  expect(store.rounds(id)).toHaveLength(2);
});

test("retry API never sends to a different session and offers recovery instead of an ineffective queue", async () => {
  const a = fake.addAgent("local", "claude", "idle"), value = "01234567-1234-4567-89ab-0123456789ab";
  const id = store.createBroadcast({ title: "retry", prompt: "old", executions: [{ machine_id: "local", machine_label: "local", target_kind: "existing", agent_kind: "claude", pane_id: a.pane_id, terminal_id: a.terminal_id, session_kind: "id", session_value: value, cwd: a.cwd }] });
  const e = store.executions(id)[0]!; store.update(e.id, { state: "lost", error: "old result" });
  fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value: "different" }; }); start();
  const response = await send(`/api/executions/${e.id}/retry`, {});
  expect(response.status).toBe(400); expect((await response.json() as any).error.message).toContain("恢复原会话");
  expect(store.execution(e.id)).toMatchObject({ state: "lost", error: "old result", session_value: value });
  expect(store.rounds(id)).toHaveLength(1); expect(fake.server().prompts).toEqual([]);
});

test("marking an uncertain send as undelivered requires explicit confirmation and does not resend", async () => {
  const a = fake.addAgent("local", "claude", "idle");
  const id = store.createBroadcast({ title: "uncertain", prompt: "p", executions: [{ machine_id: "local", machine_label: "local", target_kind: "existing", agent_kind: "claude", pane_id: a.pane_id, terminal_id: a.terminal_id }] });
  identifyHistory(id);
  const e = store.executions(id)[0]!; store.update(e.id, { state: "sent", seq_before: 10, sent_at: Date.now() }); start();
  const url = `/api/executions/${e.id}/not-delivered`;
  expect((await send(url, { terminal_id: a.terminal_id })).status).toBe(400);
  expect((await send(url, { terminal_id: "old", confirmed: true })).status).toBe(400);
  expect((await send(url, { terminal_id: a.terminal_id, confirmed: true })).status).toBe(200);
  expect(store.execution(e.id)!.state).toBe("failed"); expect(fake.server().prompts).toEqual([]);
  // a finished run has its end: the card's elapsed time stops here
  expect(store.execution(e.id)!.finished_at).not.toBeNull();
  expect((await send(url, { terminal_id: a.terminal_id, confirmed: true })).status).toBe(400);
});

test("explicit undelivered confirmation does not confuse other agent work with this message", async () => {
  const a = fake.addAgent("local", "claude", "working");
  const id = store.createBroadcast({ title: "active", prompt: "p", executions: [{ machine_id: "local", machine_label: "local", target_kind: "existing", agent_kind: "claude", pane_id: a.pane_id, terminal_id: a.terminal_id }] });
  identifyHistory(id);
  const e = store.executions(id)[0]!; store.update(e.id, { state: "sent", seq_before: 10, sent_at: Date.now() }); start();
  const response = await send(`/api/executions/${e.id}/not-delivered`, { terminal_id: a.terminal_id, confirmed: true });
  expect(response.status).toBe(200); expect(store.execution(e.id)!.state).toBe("failed"); expect(fake.server().prompts).toEqual([]);
});

describe("machines and plugin updates", () => {
  test("opening a machine in Herdr focuses its workspace there, only from this computer's own browser", async () => {
    fake.addMachine("m-1", "remote");
    const agent = fake.addAgent("m-1", "claude", "idle");
    start();
    await web.engine.refreshMachines(); await web.engine.refresh("m-1");
    const page = (await (await fetch(`${base}/api/state`)).json() as any).state.machines.find((m: any) => m.id === "m-1");
    expect(page).toMatchObject({ web_link_reason: null });
    // a proxied request is not this computer's browser
    const proxied = await fetch(`${base}/api/machines/m-1/focus`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin", "x-forwarded-for": "10.0.0.2" } });
    expect(proxied.status).toBe(403);
    expect(fake.calls().some(c => c.includes('"workspace","focus"'))).toBe(false);
    const response = await send("/api/machines/m-1/focus", {});
    expect(response.status).toBe(200);
    expect((await response.json() as any).message).toContain("remote");
    expect(fake.calls()).toContain(`m-1 ${JSON.stringify(["workspace", "focus", agent.workspace_id])}`);
    expect((await send("/api/machines/nope/focus", {})).status).toBe(404);
  });

  test("a machine with no workspace cannot be opened, and says why", async () => {
    fake.addMachine("m-2", "empty");
    start();
    await web.engine.refreshMachines(); await web.engine.refresh("m-2");
    const response = await send("/api/machines/m-2/focus", {});
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.message).toContain("暂无工作区");
  });

  test("restart is POST-only, same-origin and local, and returns the old server identity", async () => {
    start();
    let restarts = 0;
    web.updater.restart = async () => { restarts++; return web.updater.status; };
    expect((await fetch(`${base}/api/web/restart`)).status).toBe(405);
    expect((await fetch(`${base}/api/web/restart`, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/web/restart`, { method: "POST", headers: { origin: base, forwarded: "for=10.0.0.2" } })).status).toBe(403);
    expect(restarts).toBe(0);
    const config = await (await fetch(`${base}/api/config`)).json() as any;
    const response = await send("/api/web/restart", {});
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ instance: config.instance });
    expect(config.instance).toBeString();
    expect(restarts).toBe(1);
  });

  test("the update state reaches the page, and checking or installing is for this computer's browser only", async () => {
    let checks = 0, installs = 0, applies = 0;
    const status = { kind: "github", mode: "installed", available: true, phase: "idle", latest_version: "0.3.1" };
    web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] }, { tickMs: 30, localPollMs: 60, remotePollMs: 60 });
    base = `http://127.0.0.1:${web.server.port}`;
    web.updater.check = async () => { checks++; web.updater.status = { ...web.updater.status, ...status } as any; return web.updater.status; };
    web.updater.install = async () => { installs++; return web.updater.status; };
    web.updater.applyLocal = async () => { applies++; return { ...web.updater.status, operation_id: "apply-id", outcome: "running" }; };
    const remote = (path: string) => fetch(`${base}${path}`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin", forwarded: "for=10.0.0.2" } });
    expect((await remote("/api/update/check")).status).toBe(403);
    expect((await remote("/api/update/install")).status).toBe(403);
    expect((await remote("/api/update/apply")).status).toBe(403);
    expect((await fetch(`${base}/api/update/apply`)).status).toBe(405);
    expect((await fetch(`${base}/api/update/apply`, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/update/install`, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(installs + checks + applies).toBe(0);
    expect((await (await send("/api/update/check", {})).json() as any).update).toMatchObject(status);
    expect((await (await fetch(`${base}/api/state`)).json() as any).update).toMatchObject(status);
    expect((await send("/api/update/install", {})).status).toBe(202);
    const applied = await send("/api/update/apply", {});
    expect(applied.status).toBe(202); expect(await applied.json()).toMatchObject({ operationId: "apply-id", update: { outcome: "running" } });
    expect([checks, installs, applies]).toEqual([1, 1, 1]);
  });
  test("applying local code requires the configured authentication token", async () => {
    start("secret"); let applies = 0;
    web.updater.applyLocal = async () => { applies++; return web.updater.status; };
    expect((await send("/api/update/apply", {})).status).toBe(401); expect(applies).toBe(0);
    expect((await fetch(`${base}/api/update/apply`, { method: "POST", headers: { origin: base, authorization: "Bearer secret" } })).status).toBe(202);
    expect(applies).toBe(1);
  });
});

test("the page is told which build its server serves, so a page from another build reloads", async () => {
  start();
  const state = await (await fetch(`${base}/api/state`)).json() as any;
  expect(state.build).toMatch(/^[0-9a-f]{16}$/);
  const script = await (await fetch(`${base}/page.js`)).text();
  // the page compares this id on every update and reloads when a restarted server serves another
  expect(script).toContain("data.build");
  const again = await (await fetch(`${base}/api/state`)).json() as any;
  expect(again.build).toBe(state.build);
});
