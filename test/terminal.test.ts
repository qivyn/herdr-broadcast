import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Store } from "../src/db.ts";
import { startWebServer } from "../src/web/server.ts";
import { terminalCommand } from "../src/web/terminal.ts";
import { FakeHerdr, until } from "./helpers.ts";

let fake: FakeHerdr;
let store: Store;
let web: ReturnType<typeof startWebServer>;
const sockets: WebSocket[] = [];
beforeEach(() => { fake = new FakeHerdr(); store = new Store(fake.dbFile); });
afterEach(async () => { sockets.splice(0).forEach((ws) => ws.close()); await web?.stop(); store.close(); fake.cleanup(); });

function fixture(token: string | null = null) {
  const agent = fake.addAgent("local", "claude");
  const id = store.createBroadcast({ title: "Terminal", prompt: "p", executions: [{ machine_id: "local", machine_label: "Local", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id }] });
  const e = store.executions(id)[0]!;
  store.update(e.id, { state: "completed" });
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token, hosts: [] });
  const base = `http://127.0.0.1:${web.server.port}`;
  return { agent, e, base, url: `${base.replace("http", "ws")}/api/executions/${e.id}/terminal?cols=80&rows=24` };
}

function connect(url: string, origin: string, token?: string, ack = true) {
  const Ws = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const ws = new Ws(url, { headers: { origin, ...(token ? { cookie: `broadcast_token=${token}` } : {}) } });
  sockets.push(ws);
  const frames: any[] = [];
  let text = "";
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(String(event.data)); frames.push(m);
    if (m.type === "output") { text += Buffer.from(m.data, "base64").toString(); if (ack) ws.send(JSON.stringify({ type: "ack", seq: m.seq })); }
  });
  return { ws, frames, get text() { return text; } };
}

describe("streaming terminals", () => {
  test("keeps one controller for rapid Unicode input, resize and scroll; EOF releases it", async () => {
    const f = fixture();
    const client = connect(f.url, f.base);
    await until(() => client.text.includes("READY"), 5000);
    const text = "连续输入🙂abc\x7f\x03\r";
    for (const c of text) client.ws.send(JSON.stringify({ type: "input", text: c }));
    await until(() => client.text.endsWith(text), 2000).catch((e) => { throw new Error(`${e}: ${JSON.stringify(client.frames)}`); });
    client.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await until(() => client.text.includes("SIZE 100x30"), 5000);
    client.ws.send(JSON.stringify({ type: "scroll", direction: "up", lines: 10 }));
    await until(() => client.text.includes("SCROLL up 10"), 5000);
    const calls = readFileSync(fake.logFile, "utf8");
    expect(calls.match(/\["terminal","session","control"/g)?.length).toBe(1);
    expect(calls).not.toContain('"send-text"');
    expect(calls).not.toContain('"read"');
    client.ws.close();
    await until(() => existsSync(fake.logFile + ".closed"), 5000);
    expect(readFileSync(fake.logFile + ".closed", "utf8")).toContain(f.agent.terminal_id);
  });

  test("a long paste arriving as many pieces in a row keeps the connection and reaches the terminal whole", async () => {
    const f = fixture();
    const client = connect(f.url, f.base);
    await until(() => client.text.includes("READY"), 5000);
    const pieces = Array.from({ length: 24 }, (_, i) => String.fromCharCode(97 + i).repeat(8192));
    for (const text of pieces) client.ws.send(JSON.stringify({ type: "input", text }));
    await until(() => client.text.endsWith(pieces.join("")), 8000);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    expect(client.frames.some((m) => m.type === "error")).toBe(false);
  });

  test("rejects cross-origin upgrades, absent credentials, invalid geometry and missing executions", async () => {
    const f = fixture("secret");
    const path = f.url.replace("ws:", "http:");
    const request = (url: string, origin: string, token = "secret") => fetch(url, { headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}), "sec-fetch-site": "same-origin" } });
    expect((await request(path, "http://evil.example")).status).toBe(403);
    expect((await request(path, f.base, "")).status).toBe(401);
    expect((await request(path.replace("cols=80", "cols=0"), f.base)).status).toBe(400);
    expect((await request(path.replace(`/executions/${f.e.id}/`, "/executions/9999/"), f.base)).status).toBe(404);
    const client = connect(f.url, f.base, "secret");
    await until(() => client.text.includes("READY"), 5000);
    expect(client.text).toContain("中文🙂");
  });

  test("invalid messages close only their controller, and a fresh connection does not replay input", async () => {
    const f = fixture();
    const client = connect(f.url, f.base);
    await until(() => client.text.includes("READY"), 5000);
    client.ws.send(JSON.stringify({ type: "resize", cols: -1, rows: 30 }));
    await until(() => client.ws.readyState === WebSocket.CLOSED, 5000);
    expect(client.frames.some((m) => m.type === "error")).toBe(true);
    const again = connect(f.url, f.base);
    await until(() => again.text.includes("READY"), 5000);
    expect(again.text).toBe("\x1b[2J\x1b[HREADY 中文🙂\r\n");
  });

  test("bounds output until xterm acknowledges it, and rejects future acknowledgements", async () => {
    const f = fixture();
    const client = connect(f.url, f.base, undefined, false);
    await until(() => client.text.includes("READY"), 5000);
    client.ws.send(JSON.stringify({ type: "input", text: "__FAKE_FLOOD__" }));
    await until(() => client.frames.length >= 5, 5000);
    await Bun.sleep(60);
    expect(client.frames.filter((m) => m.type === "output").length).toBe(5);
    const last = client.frames.at(-1)!;
    client.ws.send(JSON.stringify({ type: "ack", seq: last.seq }));
    await until(() => client.frames.length > 5, 5000);
    client.ws.send(JSON.stringify({ type: "ack", seq: 999999 }));
    await until(() => client.ws.readyState === WebSocket.CLOSED, 5000);
    expect(client.frames.some((m) => m.type === "error")).toBe(true);
  });

  test("reports terminal.closed even when the controller exits successfully", async () => {
    const f = fixture();
    const client = connect(f.url, f.base);
    await until(() => client.text.includes("READY"), 5000);
    client.ws.send(JSON.stringify({ type: "input", text: "__FAKE_CLOSED__" }));
    await until(() => client.ws.readyState === WebSocket.CLOSED, 5000);
    expect(client.frames.find((m) => m.type === "error")).toMatchObject({ message: "正在连接…", canTakeover: true });
  });

  test("serves xterm assets locally under the existing authentication", async () => {
    const f = fixture();
    for (const path of ["/vendor/xterm.js", "/vendor/xterm.css", "/vendor/fit.js", "/vendor/unicode.js", "/terminal.js"]) {
      const response = await fetch(f.base + path);
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(100);
    }
  });

  test("remote streaming uses a persistent SSH connection and the saved session, never --machine attach", () => {
    const command = terminalCommand({ machine_id: "remote", pane_id: "w1:p1" }, 80, 24, [{ id: "remote", label: "Remote", target: "ssh://user@host:2222", session: "work", enabled: true }]);
    expect(command.slice(0, 3)).toEqual(["ssh", "-T", "-o"]);
    expect(command).toContain("BatchMode=yes");
    expect(command).toContain("2222");
    expect(command).toContain("user@host");
    expect(command.at(-1)).toContain("'--session' 'work' 'terminal' 'session' 'control' 'w1:p1'");
    expect(command.join(" ")).not.toContain("--takeover");
    expect(() => terminalCommand({ machine_id: "missing", pane_id: "w1:p1" }, 80, 24)).toThrow();
  });
});


test("occupied controllers retry without takeover and reconnect after release", async () => {
  const f = fixture();
  fake.mutate((s) => { s.servers.local!.failNext = { "terminal session": ["frame:terminal attach failed: terminal already has an attached client; retry with --takeover", "has a read in progress; retry"] }; });
  const client = connect(f.url, f.base);
  await until(() => client.frames.some((m) => m.state === "waiting"), 5000);
  expect(client.ws.readyState).toBe(WebSocket.OPEN);
  expect(client.frames.find((m) => m.state === "waiting").canTakeover).toBe(true);
  expect(client.frames.find((m) => m.state === "waiting").message).toBe("正在连接…");
  await until(() => client.text.includes("READY"), 5000);
  expect(client.frames.some((m) => m.type === "error")).toBe(false);
  const calls = fake.calls().filter((line) => line.includes('["terminal","session","control"'));
  expect(calls.length).toBe(3);
  expect(calls.some((line) => line.includes("--takeover"))).toBe(false);
});

test("closing a waiting browser cancels retries; explicit takeover applies only once", async () => {
  const f = fixture();
  fake.mutate((s) => { s.servers.local!.failNext = { "terminal session": Array(10).fill("already has an attached client; retry with --takeover") }; });
  const client = connect(f.url + "&takeover=1", f.base);
  await until(() => client.frames.filter((m) => m.state === "waiting").length >= 2, 5000);
  client.ws.close();
  await until(() => client.ws.readyState === WebSocket.CLOSED, 5000);
  const count = fake.calls().length;
  await Bun.sleep(750);
  expect(fake.calls().length).toBe(count);
  const calls = fake.calls().filter((line) => line.includes('["terminal","session","control"'));
  expect(calls[0]).toContain("--takeover");
  expect(calls.slice(1).some((line) => line.includes("--takeover"))).toBe(false);
});

test("a waiting reconnect cannot attach to a replacement terminal in the same pane", async () => {
  const f = fixture();
  fake.mutate((s) => { s.servers.local!.failNext = { "terminal session": ["already has an attached client; retry with --takeover"] }; });
  const client = connect(f.url, f.base);
  await until(() => client.frames.some((m) => m.state === "waiting"), 5000);
  fake.mutate((s) => {
    s.servers.local!.agents[0]!.terminal_id = "replacement";
    s.servers.local!.panes[0]!.terminal_id = "replacement";
  });
  await until(() => client.ws.readyState === WebSocket.CLOSED, 5000);
  expect(client.text).toBe("");
  expect(client.frames.some((m) => m.type === "error")).toBe(true);
  const calls = fake.calls().filter((line) => line.includes('["terminal","session","control"'));
  expect(calls.every((line) => line.includes(f.agent.terminal_id))).toBe(true);
  expect(calls.some((line) => line.includes("replacement"))).toBe(false);
});

test("Ctrl+C reaches the live terminal without rewriting the delivery result", async () => {
  const f = fixture();
  store.update(f.e.id, { state: "sent", saw_working: 0, seq_before: 10 });
  fake.setStatus("local", f.agent.pane_id, "working");
  const client = connect(f.url, f.base); await until(() => client.text.includes("READY"));
  client.ws.send(JSON.stringify({ type: "input", text: "\x03" }));
  await until(() => client.text.endsWith("\x03"));
  fake.setStatus("local", f.agent.pane_id, "idle");
  await web.engine.refresh("local");
  expect(store.execution(f.e.id)!.state).toBe("sent");
});

test("Ctrl+C from a historical card leaves all delivery records intact", async () => {
  const f = fixture(), value = "01234567-1234-4567-89ab-0123456789ab";
  fake.mutate(s => { const a = s.servers.local!.agents[0]!; a.agent_status = "working"; a.agent_session = { agent: "claude", kind: "id", source: "test", value }; });
  const round = store.createRound(f.e.broadcast_id, "follow up", [{ ...f.e, agent_kind: "claude", session_kind: "id", session_value: value }]);
  const active = store.executions(f.e.broadcast_id).find(e => e.round_id === round.id)!;
  store.update(active.id, { state: "sent", saw_working: 0 });
  const client = connect(f.url, f.base); await until(() => client.text.includes("READY"));
  client.ws.send(JSON.stringify({ type: "input", text: "\x03" }));
  await until(() => client.text.endsWith("\x03"));
  expect(store.execution(f.e.id)!.state).toBe("completed");
});

test("ownership loss exposes a structured takeover flag independent of its user-facing message", async () => {
  const f = fixture();
  fake.mutate(s => { s.servers.local!.failNext = { "terminal session": ["controller taken over"] }; });
  const client = connect(f.url, f.base);
  await until(() => client.ws.readyState === WebSocket.CLOSED);
  const failure = client.frames.find(m => m.type === "error");
  expect(failure).toMatchObject({ type: "error", canTakeover: true });
  expect(client.text).toBe("");
});

for (const historical of [false, true]) {
  test(`Ctrl+C preserves delivery and saved identity after a late session report on ${historical ? "a historical card's" : "the current task's"} existing socket`, async () => {
    const f = fixture(), value = "01234567-1234-4567-89ab-0123456789ab";
    fake.setStatus("local", f.agent.pane_id, "working");
    if (!historical) store.update(f.e.id, { agent_kind: "claude", state: "sent", saw_working: 0, seq_before: 10 });
    const client = connect(f.url, f.base);
    await until(() => client.text.includes("READY"));
    fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value }; });
    let active = f.e;
    if (historical) {
      const round = store.createRound(f.e.broadcast_id, "follow up", [{ ...f.e, agent_kind: "claude", session_kind: "id", session_value: value }]);
      active = store.executions(f.e.broadcast_id).find(e => e.round_id === round.id)!;
      store.update(active.id, { state: "sent", saw_working: 0, seq_before: 10 });
    }
    await web.engine.settle();
    await web.engine.refresh("local");
    expect(store.execution(active.id)!.session_value).toBe(historical ? value : null);
    client.ws.send(JSON.stringify({ type: "input", text: "\x03" }));
    await until(() => client.text.endsWith("\x03"));
    fake.setStatus("local", f.agent.pane_id, "idle");
    await web.engine.refresh("local");
    expect(store.execution(active.id)!.state).toBe("sent");
    expect(store.execution(active.id)!.session_value).toBe(historical ? value : null);
    expect(store.execution(f.e.id)!.session_value).toBeNull();
    if (historical) expect(store.execution(f.e.id)!.state).toBe("completed");
    expect(fake.calls().filter(c => c.includes('["terminal","session","control"'))).toHaveLength(1);
  });
}
