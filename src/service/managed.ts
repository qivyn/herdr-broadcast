/** The launcher never sends prompts or opens the task database. It owns process replacement. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pidAlive } from "../db.ts";
import { loadConfig } from "../config.ts";
import { Updater, type UpdateStatus } from "../update.ts";
import { atomicJSON, readJSON, runtimeState, saveRuntime, releaseEntry, socketPath, validRelease, type Release } from "./state.ts";
import { handleParent, requestChild, requestParent, serveSocket } from "./ipc.ts";
import { pruneReleases, sourceHash } from "./releases.ts";

import { UpdateJournal } from "./update-state.ts";

const START_MS = 20_000;
export async function exited(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.off("exit", exit); reject(new Error("Process did not exit after drain")); }, timeoutMs);
    const exit = () => { clearTimeout(timer); resolve(); }; child.once("exit", exit);
  });
}
function ready(child: ChildProcess, timeoutMs = START_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", fail); };
    const fail = (error: Error) => { clean(); reject(error); };
    const message = (m: any) => { if (m?.event === "ready") { clean(); resolve(m); } };
    const exit = () => fail(new Error("Candidate exited before becoming ready"));
    const timer = setTimeout(() => fail(new Error("Candidate startup timed out")), timeoutMs);
    child.on("message", message); child.once("exit", exit); child.once("error", fail);
  });
}
function start(release: Release, mode: string, database: string, dir: string) {
  return spawn(process.execPath, [releaseEntry(release), mode, database, dir, JSON.stringify(release)], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, HERDR_BROADCAST_STATUS_OWNER: "launcher" } });
}
async function stopPaused(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await requestChild(child, "exit", undefined, 10_000);
  await exited(child);
}

export async function runManager(database: string, dir: string, release: Release) {
  const bootId = randomUUID();
  const web = spawn(process.execPath, [releaseEntry(release), "web", database, dir, JSON.stringify(release)], {
    stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, HERDR_BROADCAST_BOOT_ID: bootId },
  });
  let stopping = false, initialized = false, enabled = false;
  const updater: Updater = new Updater({ stateDir: dir, current: release, sourceRoot: release.sourceRoot,
    // Older launchers still own switch/confirmation writes. Until the next full start,
    // keep preparation progress in memory rather than introducing a second writer.
    persist: async (patch, expected) => process.env.HERDR_BROADCAST_STATUS_OWNER === "launcher"
      ? requestParent("persist-update", 10_000, { patch, expected }) : { ...updater.status, ...patch },
    publish(status) { if (web.connected) web.send({ event: "update", status }); },
    async activate(next, status) {
      if (!await requestChild(web, "drain")) throw new Error("当前操作未在两分钟内完成；已取消更新并恢复服务");
      if (stopping) throw new Error("更新已取消");
      process.send?.({ event: "switch", next, status });
      // The launcher now owns the stage; this manager is about to be replaced.
    },
  });
  let draining: Promise<boolean> | null = null;
  const drain = (): Promise<boolean> => {
    if (draining) return draining;
    const wasEnabled = enabled;
    stopping = true; enabled = false;
    draining = (async () => {
      await updater.cancel();
      try {
        if (await requestChild(web, "drain")) return true;
      } catch (e) { if (!pidAlive(web.pid!)) throw e; }
      stopping = false; enabled = wasEnabled; updater.start();
      return false;
    })().finally(() => { draining = null; });
    return draining;
  };
  const command = async (name: string, value?: any): Promise<any> => {
    if (name === "status") return { update: updater.status, release, lifecycle: stopping ? "stopping" : updater.lifecycle, web: await requestChild(web, "status") };
    if (name === "describe" && (!enabled || stopping)) return updater.status;
    if (stopping && ["check", "install", "apply", "restart"].includes(name)) throw new Error("服务正在停止，请稍后重试");
    if (["check", "install", "apply", "restart"].includes(name) && !enabled) {
      if (updater.status.outcome === "running") return updater.status;
      throw new Error("管理链路正在启动，请稍后重试");
    }
    if (name === "check") return updater.check();
    if (name === "describe") return updater.describe();
    if (name === "install") return updater.install();
    if (name === "apply") return updater.applyLocal();
    if (name === "restart") return updater.restart();
    if (name === "activate") {
      if (value) { updater.status = value; web.send({ event: "update", status: value }); }
      await requestChild(web, "activate"); enabled = value?.outcome !== "running"; if (enabled) updater.start(); return true;
    }
    if (name === "confirm") { enabled = true; updater.status = value; web.send({ event: "update", status: value }); updater.start(); return true; }
    if (name === "drain") return drain();
    if (name === "resume") { await requestChild(web, "activate"); stopping = false; enabled = true; updater.start(); return true; }
    if (name === "exit") { stopping = true; updater.stop(); await stopPaused(web); setTimeout(() => process.exit(0), 20); return true; }
    throw new Error("Unknown management command");
  };
  handleParent(command);
  web.on("message", (m: any) => {
    if (!m?.parent_request) return;
    void command(m.command).then(value => { if (web.connected) web.send({ parent_reply: m.parent_request, value }); }, error => { if (web.connected) web.send({ parent_reply: m.parent_request, error: error.message }); });
  });
  web.on("exit", () => { if (!stopping && initialized) { stopping = true; void updater.cancel().finally(() => process.exit(1)); } });
  const shutdown = async () => {
    if (stopping) return;
    try { if (await drain()) { await stopPaused(web); process.exit(0); } }
    catch { if (!pidAlive(web.pid!)) process.exit(1); }
  };
  process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());
  process.on("disconnect", () => void shutdown());
  try {
    const info = await ready(web);
    const config = loadConfig();
    const response = await fetch(new URL("api/health", info.url), { headers: config.webToken ? { authorization: `Bearer ${config.webToken}` } : {}, signal: AbortSignal.timeout(1500) });
    const health = await response.json() as any;
    if (!response.ok || health.app !== "herdr-broadcast" || health.bootId !== bootId || health.hash !== release.hash || health.revision !== release.revision || health.database !== resolve(database) || health.dispatching !== false || health.schema !== 9) throw new Error("Candidate health identity mismatch");
    web.send({ event: "update", status: updater.status });
    initialized = true;
    process.send?.({ event: "ready", url: info.url, bootId, release });
  } catch (e) {
    stopping = true; updater.stop();
    // A candidate has never been activated and cannot own a send.
    web.kill("SIGTERM"); await exited(web).catch(() => web.kill("SIGKILL")); throw e;
  }
}

export async function runLauncher(database: string, dir: string, initial: Release) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "launcher.lock");
  try { mkdirSync(lock); }
  catch {
    const owner = readJSON<{ pid: number; database: string }>(join(lock, "owner.json"));
    if (!owner || owner.database !== resolve(database) || pidAlive(owner.pid)) throw new Error("Another launcher owns this service");
    rmSync(lock, { recursive: true }); mkdirSync(lock);
  }
  atomicJSON(join(lock, "owner.json"), { pid: process.pid, database: resolve(database) });
  const saved = runtimeState(dir);
  let active = saved.transaction?.previous ?? saved.current ?? initial;
  if (!validRelease(dir, active)) throw new Error("Invalid saved runtime; refusing to start an unknown directory");
  let manager: ChildProcess | undefined, writer: ChildProcess | undefined;
  let switching = false, stopping = false;
  let control: Awaited<ReturnType<typeof serveSocket>> | undefined;
  const journal = new UpdateJournal(dir);
  const status = (patch: Partial<UpdateStatus>) => journal.commit(patch);
  if (saved.transaction) {
    saveRuntime(dir, { current: active, previous: saved.previous });
    status({ phase: "error", step: null, outcome: "failed", error: "上次更新被中断，已恢复最后确认的版本", current_revision: active.revision, current_version: active.version });
  } else if (readJSON<UpdateStatus>(join(dir, "update.json"))?.outcome === "running") {
    status({ phase: "error", step: null, outcome: "failed", error: "上次更新准备被中断，仍使用最后确认的版本" });
  }
  const launch = async (release: Release) => {
    if (!validRelease(dir, release) || sourceHash(release.directory) !== release.hash) throw new Error("运行目录已改变，拒绝启动");
    const candidate = start(release, "manager", database, dir);
    candidate.on("message", (m: any) => {
      if (m?.parent_request && m.command === "persist-update") {
        try {
          if (candidate !== writer) throw new Error("管理进程已交接，拒绝过期状态");
          if (!m.value?.expected || !m.value?.patch) throw new Error("缺少更新状态校验条件");
          const value = journal.commit(m.value.patch, m.value.expected);
          candidate.send({ parent_reply: m.parent_request, value }, () => {});
        } catch (e) { if (candidate.connected) candidate.send({ parent_reply: m.parent_request, error: String((e as Error).message) }, () => {}); }
      }
      if (m?.event === "switch" && candidate === manager && !switching && !stopping) {
        const current = journal.status;
        if (current.operation_id !== m.status?.operation_id || current.phase !== "restarting" || current.outcome !== "running") return;
        void replace(m.next, current);
      }
    });
    candidate.on("exit", () => {
      if (candidate !== manager || switching || stopping) return;
      status({ phase: "error", outcome: "failed", error: "管理进程意外退出；请重新启动服务" });
      cleanup(); process.exitCode = 1;
    });
    try {
      const info = await ready(candidate);
      if (!info.bootId || info.release?.hash !== release.hash || info.release?.directory !== release.directory) throw new Error("Manager identity mismatch");
      return candidate;
    }
    catch (e) { candidate.kill("SIGTERM"); await exited(candidate).catch(() => candidate.kill("SIGKILL")); throw e; }
  };
  const replace = async (next: Release, update: UpdateStatus) => {
    if (switching) return; switching = true; writer = undefined;
    const previous = active;
    const previousRuntime = runtimeState(dir).previous;
    const retained = next.directory === previous.directory ? previousRuntime : previous;
    saveRuntime(dir, { current: previous, previous: previousRuntime, transaction: { id: update.operation_id!, previous, next, step: "starting" } });
    try {
      await stopPaused(manager!); manager = undefined;
      const candidate = await launch(next); manager = candidate;
      // Persist before allowing the first claim. A crash before final confirmation keeps the transaction recoverable.
      saveRuntime(dir, { current: next, previous: retained, transaction: { id: update.operation_id!, previous, next, step: "activating" } });
      const activating = status({ ...update, step: "activating", current_revision: next.revision, current_version: next.version });
      await requestChild(candidate, "activate", activating);
      active = next; saveRuntime(dir, { current: next, previous: retained });
      const done = status({ phase: "idle", step: null, outcome: "succeeded", available: next.directory === previous.directory ? update.available : false, error: null });
      writer = candidate;
      await requestChild(candidate, "confirm", done);
      pruneReleases(dir);
    } catch (e) {
      try {
        if (manager && manager.exitCode === null) {
          if (!await requestChild(manager, "drain")) throw new Error("候选服务仍有在途操作，不能安全回退");
          await stopPaused(manager);
        }
        manager = await launch(previous); active = previous;
        const failed = { ...update, phase: "error" as const, step: null, outcome: "failed" as const, current_revision: previous.revision, current_version: previous.version, error: `操作失败，已恢复旧版：${String((e as Error).message)}` };
        saveRuntime(dir, { current: previous, previous: previousRuntime });
        status(failed); writer = manager;
        await requestChild(manager, "activate", failed); pruneReleases(dir);
      } catch (rollback) { status({ phase: "error", outcome: "failed", error: `更新恢复失败：${String((rollback as Error).message)}` }); console.error(rollback); }
    } finally { switching = false; }
  };
  const cleanup = () => { control?.close(); rmSync(socketPath(database), { force: true }); rmSync(lock, { recursive: true, force: true }); };
  let stopJob: Promise<string> | null = null;
  const stop = (): Promise<string> => {
    if (stopJob) return stopJob;
    if (switching) return Promise.reject(new Error("正在切换版本，请稍后停止"));
    stopping = true;
    stopJob = (async () => {
      try {
        if (manager && manager.exitCode === null) {
          if (!await requestChild(manager, "drain")) { stopping = false; return "failed"; }
          writer = undefined;
          await stopPaused(manager);
        }
        // Flush the socket reply first. CLI callers wait for this owner and its lock to disappear.
        setTimeout(() => { cleanup(); process.exit(0); }, 50);
        return "stopped";
      } catch (e) { stopping = false; throw e; }
      finally { if (!stopping) stopJob = null; }
    })();
    return stopJob;
  };
  process.on("SIGTERM", () => void stop().catch(console.error)); process.on("SIGINT", () => void stop().catch(console.error));
  try {
    manager = await launch(active); writer = manager;
    await requestChild(manager, "activate", status({ current_revision: active.revision, current_version: active.version }));
    saveRuntime(dir, { current: active, previous: saved.previous });
    pruneReleases(dir);
    control = await serveSocket(socketPath(database), async command => {
      if (command === "stop") return stop();
      if (command === "status" && (switching || stopping)) return { update: journal.status, release: active, switching, lifecycle: stopping ? "stopping" : "switching" };
      if (command === "describe" && (switching || stopping)) return journal.status;
      if (stopping) throw new Error("服务正在停止，请稍后重试");
      if (switching) {
        if (command === "install" || command === "apply" || command === "restart") return journal.status;
        throw new Error("正在切换版本");
      }
      if (!["status", "describe", "check", "install", "apply", "restart"].includes(command)) throw new Error("Unknown command");
      const result = await requestChild(manager!, command);
      return command === "status" ? { ...result, update: journal.status } : result;
    });
    process.send?.({ event: "ready" });
  } catch (e) { cleanup(); if (manager) { await requestChild(manager, "drain").catch(() => {}); await stopPaused(manager).catch(() => {}); } throw e; }
}
