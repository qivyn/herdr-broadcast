/**
 * Starting, stopping and watching the web page's server.
 *
 * Herdr's startup hooks are one-shot initialization commands, not supervised daemons
 * (https://herdr.dev/docs/plugins/), so this module owns the process the way herdr-web-ui does:
 * `start` detaches the server and waits until it answers, `stop` takes it down, `status` reports.
 * Start is idempotent — a server already answering is left alone — which is what makes it safe as
 * both the startup hook and a hand-invoked action.
 *
 * The server runs the plugin's files, and Herdr may remove an installation's files once the
 * commands launched from it have exited, which a detached server has not. So it runs a copy of
 * `src` under the plugin's state directory, keyed by a hash of it: an update writes a new copy,
 * and the server a start before it is already running stays where it was.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { pidAlive, type Store } from "../db.ts";
import { DEFAULT_WEB_PORT, startWebServer, WEB_LOCK, webOptions } from "./server.ts";
import { findSelf, installedPlugins, type UpdateController } from "../update.ts";
import { snapshotSource } from "../service/releases.ts";
import { callSocket, handleParent } from "../service/ipc.ts";
import { readJSON, releaseEntry, runtimeState, stateDirectory, socketPath, type Release } from "../service/state.ts";

const STALE_MS = 20_000;
/** how long a start waits for the server to answer before saying it did not */
const READY_TIMEOUT_MS = 20_000;
/** Let active sends and launches complete without terminating their subprocesses. */
const DRAIN_TIMEOUT_MS = 120_000;
/** the next ports a start tries when the default one is taken */
const FALLBACK_PORTS = [7325, 7326, 7327, 7328];

/** The plugin's state directory, where the server's log, port and runtime copy live. */
export function stateDir(store: Store): string {
  // Keep the default session's existing location; every other database owns its
  // metadata and runtime copies, so another session cannot overwrite or prune them.
  const dir = stateDirectory(store.path);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The port a start settled on because the default could not be opened; absent while the default serves. */
function savedPort(store: Store): number | null {
  try {
    const port = Number(readFileSync(join(stateDir(store), "web-port"), "utf8").trim());
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
}

/** What the running server wrote about itself: its pid, port and address. */
interface WebInfo {
  database?: string;
  pid: number;
  port: number;
  url: string;
}

function webInfoFile(store: Store): string {
  return join(stateDir(store), "web.json");
}

/** The server's own note, if the process it names is still there. */
function readWebInfo(store: Store): WebInfo | null {
  try {
    const info = JSON.parse(readFileSync(webInfoFile(store), "utf8")) as WebInfo;
    const owned = info.database ? info.database === resolve(store.path) : store.lockHolder(WEB_LOCK, pidAlive, STALE_MS) === info.pid;
    return owned && Number.isInteger(info.port) && typeof info.url === "string" && pidAlive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

export function webUrl(store?: Store): string {
  const options = webOptions();
  const host = options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host;
  // a port the user set is the only one they mean; otherwise the running server, then a saved one
  const configured = loadConfig().webPort;
  const info = store && !configured ? readWebInfo(store) : null;
  if (info) return info.url;
  const port = configured ?? (store ? savedPort(store) : null) ?? DEFAULT_WEB_PORT;
  return `http://${host}:${port}/`;
}

/** The ports a start tries, in order: a port the user set is theirs alone; the default gives way to the next free one. */
function candidates(store: Store): number[] {
  const configured = loadConfig().webPort;
  if (configured) return [configured];
  const saved = savedPort(store);
  return [...new Set([saved ?? DEFAULT_WEB_PORT, DEFAULT_WEB_PORT, ...FALLBACK_PORTS])];
}

/** Whether the page answers at `url`: this plugin's own answer, not another program's. */
export async function webAnswers(url: string = webUrl()): Promise<boolean> {
  const token = loadConfig().webToken;
  try {
    const response = await fetch(new URL("api/state", url), {
      signal: AbortSignal.timeout(1_500),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { app?: unknown; state?: unknown };
    // another plugin's page, or the herdr-web-ui on the same port, answers differently
    return body.app === "herdr-broadcast" && typeof body.state === "object" && body.state !== null;
  } catch {
    return false;
  }
}

/** Runs the server in this process until it is told to stop. */
export async function runWeb(store: Store, log: (line: string) => void = (l) => console.log(l), managed?: { release: Release; controller: UpdateController; bootId: string }): Promise<void> {
  const held = store.db.query<{ pid: number }, [string]>("SELECT pid FROM locks WHERE name = ?").get(WEB_LOCK);
  if ((held && held.pid !== process.pid && pidAlive(held.pid)) || !store.acquireLock(WEB_LOCK, pidAlive, STALE_MS)) {
    log(`already running: ${webUrl(store)}`);
    return;
  }
  const base = webOptions();
  let web: ReturnType<typeof startWebServer> | null = null;
  let port = 0;
  let lastError: unknown = null;
  for (const candidate of candidates(store)) {
    try {
      web = startWebServer(store, { ...base, port: candidate, checkUpdates: false, paused: !!managed, runtime: managed ? { revision: managed.release.revision, hash: managed.release.hash, database: resolve(store.path), bootId: managed.bootId } : undefined }, undefined, managed?.controller);
      port = candidate;
      break;
    } catch (error) {
      lastError = error;
      // a port someone else holds: the next candidate may be free. Another failure is not a port's
      const code = (error as { code?: string }).code;
      if (code !== "EADDRINUSE" && !/address already in use|is port .* in use/i.test(String(error))) {
        store.releaseLock(WEB_LOCK);
        throw error;
      }
    }
  }
  if (!web) {
    store.releaseLock(WEB_LOCK);
    throw lastError ?? new Error("no port to serve on");
  }
  // remembered only when the default gave way, so a later start, status or stop finds this one
  if (!loadConfig().webPort && port !== DEFAULT_WEB_PORT) writeFileSync(join(stateDir(store), "web-port"), String(port));
  const url = web.url;
  writeFileSync(webInfoFile(store), JSON.stringify({ database: resolve(store.path), pid: process.pid, port, url }));
  writeFileSync(join(stateDir(store), "web.pid"), String(process.pid));
  log(`broadcast web page: ${url}`);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const stop = async () => { if (await web!.drain()) finish(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", stop);
  const detach = managed ? handleParent(async command => {
    if (command === "status") return { url, pid: process.pid };
    if (command === "activate") { web!.resume(); return true; }
    if (command === "drain") return web!.drain();
    if (command === "exit") { finish(); return true; }
    throw new Error("Unknown service command");
  }) : () => {};
  if (managed) process.send?.({ event: "ready", url });
  await done;
  process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGHUP", stop); detach();
  await web.stop();
  store.releaseLock(WEB_LOCK);
  rmSync(webInfoFile(store), { force: true });
  rmSync(join(stateDir(store), "web.pid"), { force: true });
}

/** One-time adoption: never race an older sender, including a hook already in flight. */
export async function drainLegacy(store: Store, timeoutMs = 120_000): Promise<void> {
  const holders = store.db.query<{ pid: number }, []>("SELECT pid FROM locks WHERE name IN ('web', 'worker')").all().filter(x => x.pid !== process.pid && pidAlive(x.pid));
  const owners = () => store.db.query<{ owner_pid: number }, []>("SELECT DISTINCT owner_pid FROM executions WHERE state IN ('sending', 'starting') AND owner_pid IS NOT NULL").all().filter(x => x.owner_pid !== process.pid && pidAlive(x.owner_pid));
  if (!holders.length && !owners().length && runtimeState(stateDir(store)).current) return;
  const self = findSelf(await installedPlugins());
  if (!self) throw new Error("首次迁移需要先通过 Herdr 更新或重新链接插件");
  const manifest = readFileSync(join(self.plugin_root, "herdr-plugin.toml"), "utf8");
  if (/\[\[events\]\]|id\s*=\s*"worker"/.test(manifest) || self.events?.length || self.actions?.some(a => (a.id ?? a.action_id)?.endsWith("worker"))) throw new Error("请先重新链接插件以撤销旧 worker 和事件入口，再重启");
  for (const { pid } of holders) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const deadline = Date.now() + timeoutMs;
  while (holders.some(x => pidAlive(x.pid)) || owners().length) {
    if (Date.now() >= deadline) throw new Error("旧广播执行者仍在排空；未启动新执行器，请稍后重试");
    await Bun.sleep(100);
  }
  for (const { pid } of holders) { store.releaseLock("worker", pid); store.releaseLock(WEB_LOCK, pid); }
}

export async function startWebDetached(store: Store): Promise<{ how: "running" | "started" | "failed"; url: string; error?: string }> {
  try {
    const owner = readJSON<{ pid: number }>(join(stateDir(store), "launcher.lock", "owner.json"));
    let state: any;
    try { state = await callSocket(socketPath(store.path), "status", 2000); }
    catch (e) {
      if (!["ENOENT", "ECONNREFUSED"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    }
    if (!state && owner && pidAlive(owner.pid)) state = { lifecycle: "starting" };
    if (state) {
      // A responding manager owns startup, even while there is no Web child to answer yet.
      const deadline = Date.now() + READY_TIMEOUT_MS + 5000;
      while (Date.now() < deadline) {
        if (!state.switching && state.lifecycle !== "stopping" && state.web?.url && await webAnswers(state.web.url)) return { how: "running", url: state.web.url };
        const wasStopping = state.lifecycle === "stopping";
        await Bun.sleep(100);
        try { state = await callSocket(socketPath(store.path), "status", 2000); }
        catch (e) {
          if (wasStopping && ["ENOENT", "ECONNREFUSED"].includes((e as NodeJS.ErrnoException).code ?? "")) {
            await waitLauncherStopped(store, owner);
            return startWebDetached(store);
          }
          if (state.lifecycle === "starting" && owner && pidAlive(owner.pid)) continue;
          throw new Error("管理链路已响应但服务尚未就绪，请查看服务日志");
        }
      }
      throw new Error("管理链路仍在启动或切换，请稍后重试");
    }
    if (store.lockHolder(WEB_LOCK, pidAlive, STALE_MS)) throw new Error("已有 Web 服务持有锁；请执行重启完成迁移");
    const legacy = readWebInfo(store);
    if (legacy && pidAlive(legacy.pid)) throw new Error("旧 Web 服务仍在运行；请执行重启以完成迁移");
    await drainLegacy(store);
    const dir = stateDir(store);
    const source = process.env.HERDR_PLUGIN_ROOT || resolve(import.meta.dir, "../..");
    const saved = runtimeState(dir);
    const release = saved.transaction?.previous ?? saved.current ?? await snapshotSource(source, dir);
    const log = openSync(join(dir, "web.log"), "a");
    // The launcher's files live in our state directory, independently of Herdr's install cleanup.
    const child = spawn(process.execPath, [releaseEntry(release), "launcher", resolve(store.path), dir, JSON.stringify(release)], { detached: true, stdio: ["ignore", log, log], env: process.env });
    closeSync(log); child.unref();
    const deadline = Date.now() + READY_TIMEOUT_MS + 5000;
    while (Date.now() < deadline) {
      try { const state = await callSocket(socketPath(store.path), "status", 1000); if (state.web?.url && await webAnswers(state.web.url)) return { how: "started", url: state.web.url }; } catch {}
      if (child.exitCode !== null) break;
      await Bun.sleep(100);
    }
    throw new Error(`管理服务没有启动，请查看 ${join(dir, "web.log")}`);
  } catch (e) { return { how: "failed", url: webUrl(store), error: String((e as Error).message) }; }
}
async function waitOperation(store: Store, operationId: string): Promise<{ how: "started"; url: string }> {
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const current = await callSocket(socketPath(store.path), "status").catch(() => null);
    if (current?.update?.operation_id === operationId && current.update.outcome !== "running") {
      if (current.update.outcome === "failed") throw new Error(current.update.error);
      return { how: "started", url: current.web?.url ?? webUrl(store) };
    }
    await Bun.sleep(200);
  }
  throw new Error("操作尚未完成，请在设置中查看进度或检查服务日志");
}

/** Manual local apply uses the authenticated API, including with an older launcher. */
export async function applyLocalWeb(store: Store): Promise<{ how: "started" | "failed"; url: string; error?: string }> {
  try {
    const info = readWebInfo(store);
    if (!info) throw new Error("Broadcast Web 服务未运行，请先运行 web-start");
    const token = loadConfig().webToken;
    const headers: Record<string, string> = { origin: new URL(info.url).origin };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(new URL("api/update/apply", info.url), { method: "POST", headers, signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as { operationId?: string; error?: { message: string } };
    if (!response.ok || !result.operationId) throw new Error(result.error?.message ?? "服务尚不支持应用本地代码，请先完成服务升级");
    return await waitOperation(store, result.operationId);
  } catch (e) { return { how: "failed", url: webUrl(store), error: String((e as Error).message) }; }
}

export async function restartWeb(store: Store): Promise<{ how: "started" | "running" | "failed"; url: string; error?: string }> {
  try {
    let operation: any;
    try { operation = await callSocket(socketPath(store.path), "restart"); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw e;
      await drainLegacy(store); return startWebDetached(store);
    }
    return await waitOperation(store, operation.operation_id);
  } catch (e) { return { how: "failed", url: webUrl(store), error: String((e as Error).message) }; }
}
async function waitLauncherStopped(store: Store, owner = readJSON<{ pid: number }>(join(stateDir(store), "launcher.lock", "owner.json"))): Promise<void> {
  if (!owner) return;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (pidAlive(owner.pid) || readJSON<{ pid: number }>(join(stateDir(store), "launcher.lock", "owner.json"))?.pid === owner.pid) {
    if (Date.now() >= deadline) throw new Error("停止请求已接收，但管理进程或锁尚未释放");
    await Bun.sleep(25);
  }
}
export async function stopWeb(store: Store): Promise<"stopped" | "not-running" | "failed"> {
  try {
    const owner = readJSON<{ pid: number }>(join(stateDir(store), "launcher.lock", "owner.json"));
    const result = await callSocket(socketPath(store.path), "stop");
    if (result === "stopped") await waitLauncherStopped(store, owner);
    return result;
  }
  catch (e) {
    if (!["ENOENT", "ECONNREFUSED"].includes((e as NodeJS.ErrnoException).code ?? "")) return "failed";
    const pid = store.lockHolder(WEB_LOCK, pidAlive, STALE_MS);
    if (!pid) return "not-running";
    try { process.kill(pid, "SIGTERM"); } catch { return "not-running"; }
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (pidAlive(pid)) { if (Date.now() >= deadline) return "failed"; await Bun.sleep(100); }
    return "stopped";
  }
}
export async function webStatus(store: Store) {
  const info = readWebInfo(store), url = webUrl(store);
  return { running: !!info, pid: info?.pid ?? null, answering: !!info && await webAnswers(url), url, port: info?.port ?? savedPort(store) ?? DEFAULT_WEB_PORT };
}
