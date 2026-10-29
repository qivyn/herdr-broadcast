import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store, pidAlive } from "../src/db.ts";
import { applyLocalWeb, restartWeb, runWeb, startWebDetached, stateDir, stopWeb, webUrl, webStatus } from "../src/web/launch.ts";
import { serveSocket } from "../src/service/ipc.ts";
import { socketPath } from "../src/service/state.ts";
import { WEB_LOCK } from "../src/web/server.ts";
import { FakeHerdr, until } from "./helpers.ts";

test("CLI local apply needs an owned running service and submits through its authenticated API", async () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile), prior = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = join(fake.dir, "config"); mkdirSync(process.env.HERDR_PLUGIN_CONFIG_DIR);
  writeFileSync(join(process.env.HERDR_PLUGIN_CONFIG_DIR, "config.toml"), 'web_token = "test-token"\n');
  const requests: { url: string; method: string; headers: Headers }[] = [], commands: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { requests.push({ url: req.url, method: req.method, headers: new Headers(req.headers) }); return Response.json({ operationId: "local-apply" }, { status: 202 }); } });
  const url = `http://127.0.0.1:${server.port}/`;
  const control = await serveSocket(socketPath(store.path), async command => { commands.push(command); return { update: { operation_id: "local-apply", outcome: "succeeded" }, web: { url } }; });
  try {
    expect((await applyLocalWeb(store)).how).toBe("failed"); expect(requests).toEqual([]);
    const info = { database: resolve(fake.dir, "other.sqlite"), pid: process.pid, port: server.port, url };
    writeFileSync(join(stateDir(store), "web.json"), JSON.stringify(info));
    expect((await applyLocalWeb(store)).how).toBe("failed"); expect(requests).toEqual([]);
    writeFileSync(join(stateDir(store), "web.json"), JSON.stringify({ ...info, database: resolve(store.path) }));
    expect(await applyLocalWeb(store)).toEqual({ how: "started", url });
    expect(requests).toHaveLength(1); expect(new URL(requests[0]!.url).pathname).toBe("/api/update/apply");
    expect(requests[0]!.method).toBe("POST"); expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-token");
    expect(requests[0]!.headers.get("origin")).toBe(new URL(url).origin); expect(commands).toEqual(["status"]);
  } finally {
    await new Promise<void>(resolve => control.close(() => resolve())); await server.stop(true);
    if (prior === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR; else process.env.HERDR_PLUGIN_CONFIG_DIR = prior;
    store.close(); fake.cleanup();
  }
});

test("session servers keep independent metadata, fallback ports and shutdown lifecycles", async () => {
  const fake = new FakeHerdr();
  const first = new Store(fake.dbFile), second = new Store(join(fake.dir, "broadcast-named.sqlite"));
  const config = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = join(fake.dir, "empty-config");
  const ports = new Set<number>();
  const serve = spyOn(Bun, "serve").mockImplementation((options: any) => {
    if (ports.has(options.port)) throw Object.assign(new Error("port busy"), { code: "EADDRINUSE" });
    ports.add(options.port);
    return { port: options.port, stop() { ports.delete(options.port); } } as any;
  });
  const logs: string[] = [];
  let stopFirst: (() => void) | undefined, stopSecond: (() => void) | undefined;
  let one: Promise<void> | undefined, two: Promise<void> | undefined;
  try {
    const before = new Set(process.listeners("SIGTERM"));
    one = runWeb(first, line => logs.push(line));
    stopFirst = process.listeners("SIGTERM").find(fn => !before.has(fn)) as () => void;
    const middle = new Set(process.listeners("SIGTERM"));
    two = runWeb(second, line => logs.push(line));
    stopSecond = process.listeners("SIGTERM").find(fn => !middle.has(fn)) as () => void;
    expect(logs).toEqual(["broadcast web page: http://127.0.0.1:7318/", "broadcast web page: http://127.0.0.1:7325/"]);
    expect(webUrl(first)).toBe("http://127.0.0.1:7318/");
    expect(webUrl(second)).toBe("http://127.0.0.1:7325/");
    expect(stateDir(first)).not.toBe(stateDir(second));
    expect(existsSync(join(stateDir(first), "web-port"))).toBe(false);
    expect(existsSync(join(stateDir(second), "web-port"))).toBe(true);
    stopFirst(); await one;
    expect(existsSync(join(stateDir(first), "web.json"))).toBe(false);
    expect(existsSync(join(stateDir(second), "web.json"))).toBe(true);
    expect(existsSync(join(stateDir(second), "web.pid"))).toBe(true);
    expect(second.lockHolder(WEB_LOCK, pidAlive, 20_000)).toBe(process.pid);
    expect(webUrl(second)).toBe("http://127.0.0.1:7325/");
    expect(ports).toEqual(new Set([7325]));
  } finally {
    stopFirst?.(); stopSecond?.();
    await Promise.all([one, two]);
    serve.mockRestore();
    if (config === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = config;
    first.close(); second.close(); fake.cleanup();
  }
});

test("service information must belong to its database; legacy metadata needs the matching lock", () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile);
  const config = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = join(fake.dir, "empty-config");
  try {
    const file = join(stateDir(store), "web.json");
    const info = { pid: process.pid, port: 7325, url: "http://127.0.0.1:7325/" };
    writeFileSync(file, JSON.stringify(info));
    expect(webUrl(store)).toBe("http://127.0.0.1:7318/");
    store.acquireLock(WEB_LOCK, pidAlive, 20_000);
    expect(webUrl(store)).toBe(info.url);
    writeFileSync(file, JSON.stringify({ ...info, database: resolve(fake.dir, "another.sqlite") }));
    expect(webUrl(store)).toBe("http://127.0.0.1:7318/");
    writeFileSync(file, JSON.stringify({ ...info, database: resolve(store.path) }));
    expect(webUrl(store)).toBe(info.url);
  } finally {
    if (config === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = config;
    store.close(); fake.cleanup();
  }
});

test("a lock without owned metadata cannot claim an unrelated server on the default port", async () => {
  const fake = new FakeHerdr(), store = new Store(join(fake.dir, "broadcast-named.sqlite"));
  const config = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = join(fake.dir, "empty-config");
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ app: "herdr-broadcast", state: {} })));
  try {
    store.acquireLock(WEB_LOCK, pidAlive, 20_000);
    expect((await startWebDetached(store)).how).toBe("failed");
    expect((await webStatus(store)).answering).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    if (config === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = config;
    store.close(); fake.cleanup();
  }
});


test("managed restart drains accepted sends, preserves results and serves the same database", async () => {
  const fake = new FakeHerdr(), store = new Store(fake.dbFile);
  const env = { config: process.env.HERDR_PLUGIN_CONFIG_DIR, state: process.env.HERDR_PLUGIN_STATE_DIR, root: process.env.HERDR_PLUGIN_ROOT };
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const port = probe.port; probe.stop(true);
  process.env.HERDR_PLUGIN_CONFIG_DIR = join(fake.dir, "config"); process.env.HERDR_PLUGIN_STATE_DIR = fake.dir;
  process.env.HERDR_PLUGIN_ROOT = resolve(import.meta.dir, "..");
  mkdirSync(process.env.HERDR_PLUGIN_CONFIG_DIR, { recursive: true });
  writeFileSync(join(process.env.HERDR_PLUGIN_CONFIG_DIR, "config.toml"), `web_port = ${port}\n`);
  try {
    const started = await startWebDetached(store);
    if (started.how === "failed") throw new Error(started.error + "\n" + await Bun.file(join(fake.dir, "web.log")).text());
    const agent = fake.addAgent("local", "claude");
    fake.mutate(s => { s.servers.local!.promptDelayMs = 1000; });
    const target = { machine_id: "local", machine_label: "Local", target_kind: "existing" as const, agent_kind: "claude", pane_id: agent.pane_id, terminal_id: agent.terminal_id };
    const submit = async (prompt: string) => {
      const url = `http://127.0.0.1:${port}`;
      const response = await fetch(url + "/api/broadcasts", { method: "POST", headers: { origin: url, "content-type": "application/json" },
        body: JSON.stringify({ prompt, targets: [{ machine: "local", pane: agent.pane_id, terminal_id: agent.terminal_id }] }) });
      expect(response.ok).toBe(true); return (await response.json() as any).id as number;
    };
    const first = await submit("first"), second = await submit("second");
    await until(() => store.executions(first)[0]!.sent_at !== null, 10_000);
    const before = (await webStatus(store)).pid;
    const restarted = await restartWeb(store);
    if (restarted.how === "failed") throw new Error(restarted.error + "\n" + await Bun.file(join(fake.dir, "web.log")).text());
    expect(restarted.how).toBe("started");
    expect((await webStatus(store)).pid).not.toBe(before);
    expect(store.executions(first)[0]!.state).toBe("sent");
    expect(store.executions(second)[0]!.state).toBe("sent");
    expect(fake.server().prompts.map(p => p.text)).toEqual(["first", "second"]);
    fake.quickTurn("local", agent.pane_id);
    await until(() => store.executions(second)[0]!.state === "sent", 12_000);
    expect(fake.server().prompts.map(p => p.text)).toEqual(["first", "second"]);
    expect(store.db.query("SELECT * FROM locks WHERE name = 'worker'").all()).toEqual([]);
  } finally {
    await stopWeb(store); await Bun.sleep(150);
    for (const [key, value] of [["HERDR_PLUGIN_CONFIG_DIR", env.config], ["HERDR_PLUGIN_STATE_DIR", env.state], ["HERDR_PLUGIN_ROOT", env.root]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
    store.close(); fake.cleanup();
  }
}, 60_000);

// Migration tests use only an inert temporary child; it cannot call Herdr or send prompts.
for(const timeout of [false,true]) test(`legacy executors ${timeout ? 'block migration on timeout without a force kill' : 'finish before the new engine may start'}`,async()=>{
  const { drainLegacy }=await import('../src/web/launch.ts');
  const fake=new FakeHerdr(),store=new Store(fake.dbFile),root=join(fake.dir,'legacy-source');mkdirSync(root);
  writeFileSync(join(root,'herdr-plugin.toml'),'id = "herdr-broadcast"\n');
  const prior=process.env.HERDR_PLUGIN_ROOT;process.env.HERDR_PLUGIN_ROOT=root;
  const entry=join(fake.dir,'legacy.ts'),ready=join(fake.dir,'ready');
  writeFileSync(entry,`process.on('SIGTERM',()=>{${timeout ? '' : 'setTimeout(()=>process.exit(0),120);'}});await Bun.write(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`);
  const child=Bun.spawn([process.execPath,entry],{stdout:'ignore',stderr:'ignore'});
  try{
    await until(()=>existsSync(ready));store.acquireLock('worker',pidAlive,20000,child.pid);
    if(timeout){await expect(drainLegacy(store,30)).rejects.toThrow('旧广播执行者');expect(pidAlive(child.pid)).toBe(true);}
    else{await drainLegacy(store,2000);expect(pidAlive(child.pid)).toBe(false);expect(store.lockHolder('worker',pidAlive,20000)).toBeNull();}
    expect(fake.server().prompts).toEqual([]);
  }finally{child.kill('SIGKILL');await child.exited;if(prior===undefined)delete process.env.HERDR_PLUGIN_ROOT;else process.env.HERDR_PLUGIN_ROOT=prior;store.close();fake.cleanup();}
});
test('a refreshed source manifest alone is insufficient while Herdr still registers old event hooks',async()=>{
  const { drainLegacy }=await import('../src/web/launch.ts');
  const fake=new FakeHerdr(),store=new Store(fake.dbFile),root=join(fake.dir,'source');mkdirSync(root);writeFileSync(join(root,'herdr-plugin.toml'),'id = "herdr-broadcast"\n');
  const prior=process.env.HERDR_PLUGIN_ROOT;process.env.HERDR_PLUGIN_ROOT=root;process.env.FAKE_PLUGIN_EVENTS='[{"on":"pane.agent_status_changed"}]';
  try{await expect(drainLegacy(store,30)).rejects.toThrow('撤销旧 worker');expect(fake.server().prompts).toEqual([]);}
  finally{delete process.env.FAKE_PLUGIN_EVENTS;if(prior===undefined)delete process.env.HERDR_PLUGIN_ROOT;else process.env.HERDR_PLUGIN_ROOT=prior;store.close();fake.cleanup();}
});
