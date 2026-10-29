/** Real terminal integration test. All Herdr state and panes belong to a disposable config. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Store } from "../src/db.ts";
import { startWebServer } from "../src/web/server.ts";
import { runHerdr } from "../src/herdr.ts";
import { isolatedHerdr } from "./e2e-environment.ts";

const environment = await isolatedHerdr("stream");
const { root } = environment;
const cli = async (args: string[]) => {
  const result = await runHerdr(args);
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};
const wait = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 500; i++) { if (check()) return; await Bun.sleep(10); }
  throw new Error(`Timed out: ${what}`);
};
const store = new Store(join(root, "broadcast.sqlite"));
let web: ReturnType<typeof startWebServer> | undefined;
interface Client {
  ws: WebSocket;
  term: Terminal;
  errors: { message: string; canTakeover: boolean }[];
  statuses: { state?: string }[];
  frames: number;
  lines(): string[];
  send(text: string): void;
}
const clients: Client[] = [];
function connect(execId: number, takeover = false): Client {
  const base = web!.url.replace(/\/$/, "");
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 0 });
  term.loadAddon(new UnicodeGraphemesAddon());
  const Ws = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const ws = new Ws(`${base.replace("http:", "ws:")}/api/executions/${execId}/terminal?cols=80&rows=24${takeover ? "&takeover=1" : ""}`, { headers: { origin: base } });
  const errors: { message: string; canTakeover: boolean }[] = [];
  const statuses: any[] = [];
  let frames = 0;
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.type === "status") statuses.push(m);
    if (m.type === "error") errors.push({ message: m.message, canTakeover: m.canTakeover === true });
    if (m.type === "output") term.write(Buffer.from(m.data, "base64"), () => {
      frames++;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ack", seq: m.seq }));
    });
  };
  const client = { ws, term, errors, statuses, get frames() { return frames; },
    lines: () => Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true).trim() || ""),
    send: (text: string) => ws.send(JSON.stringify({ type: "input", text })),
  };
  clients.push(client);
  return client;
}
try {
  const executions = [];
  for (let i = 0; i < 2; i++) {
    const { result } = JSON.parse(await cli(["workspace", "create", "--cwd", root, "--label", `Stream test ${i}`, "--no-focus"]));
    executions.push({ machine_id: "local", machine_label: "Local", target_kind: "existing" as const, pane_id: result.root_pane.pane_id, terminal_id: result.root_pane.terminal_id });
  }
  const id = store.createBroadcast({ title: "Stream test", prompt: "Test only", executions });
  const runs = store.executions(id);
  for (const e of runs) store.update(e.id, { state: "completed" });
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
  const one = connect(runs[0]!.id), two = connect(runs[1]!.id);
  await wait(() => one.frames > 0 && two.frames > 0, "initial screen");
  const latency: number[] = [];
  let typed = `probe${Date.now()}_`;
  one.send(typed);
  await wait(() => one.lines().some((line) => line.includes(typed)), "unique input prefix");
  for (const key of "abcdefghijklmnopqrst") {
    typed += key;
    const start = performance.now();
    one.send(key);
    await wait(() => one.lines().some((line) => line.includes(typed)), "keystroke echo");
    latency.push(performance.now() - start);
  }
  // Clear the unfinished latency probe without a SIGINT that can flush the next
  // queued command before the Linux shell has handled the signal.
  one.send("\x15\r"); two.send("\x15\r");
  const marker = `STREAM_中文🙂_OK_${Date.now()}`;
  // Start output on its own row: dash may render a pending prompt before it.
  for (const client of [one, two]) client.send(`printf '\\n${marker}\\n'\r`);
  await wait(() => one.lines().includes(marker) && two.lines().includes(marker), "Unicode output on both terminals");
  one.term.resize(100, 30);
  one.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  one.send("printf '\\n'; stty size\r");
  await wait(() => one.lines().includes("30 100"), "terminal resize");
  const duplicate = connect(runs[0]!.id);
  await wait(() => duplicate.statuses.some((m) => m.state === "waiting"), "occupied controller waits").catch((error) => { throw new Error(`${error}: ${JSON.stringify({ errors: duplicate.errors, statuses: duplicate.statuses, frames: duplicate.frames })}`); });
  assert.equal(duplicate.frames, 0);
  assert.equal(duplicate.errors.length, 0);
  one.ws.close();
  await wait(() => duplicate.frames > 0, "waiting controller reconnects after release");
  const takeover = connect(runs[0]!.id, true);
  await wait(() => takeover.frames > 0 && duplicate.errors.length > 0, "explicit takeover");
  assert.equal(duplicate.errors[0]!.canTakeover, true);
  assert.deepEqual(takeover.errors, []);
  const preserved = `PRESERVED_${Date.now()}`;
  takeover.send(`printf '\\n${preserved}\\n'\r`);
  await wait(() => takeover.lines().includes(preserved), "same shell remains usable");
  takeover.ws.close();
  const again = connect(runs[0]!.id);
  await wait(() => again.frames > 0 || again.errors.length > 0, "immediate reconnect");
  assert.equal(again.errors.length, 0);
  assert.deepEqual(one.errors, []); assert.deepEqual(two.errors, []);
  latency.sort((a, b) => a - b);
  console.log(JSON.stringify({ result: "passed", samples: latency.length, medianEchoMs: latency[10], maxEchoMs: Math.max(...latency), checks: ["Unicode", "two terminals", "resize", "wait for owner release", "explicit takeover", "shell preserved", "immediate reconnect"] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ terminals: clients.map(c => ({ lines: c.lines(), errors: c.errors, statuses: c.statuses })) }, null, 2));
  environment.diagnostics(); throw error;
} finally {
  for (const client of clients) { client.ws.close(); client.term.dispose(); }
  try { await web?.stop(); store.close(); }
  finally { await environment.close(); }
}
