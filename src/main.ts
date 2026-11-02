#!/usr/bin/env bun
/**
 * herdr-broadcast entry point. The plugin's interface is its web page; these are what the
 * manifest runs, and a command line for scripts.
 *
 *   worker             obsolete compatibility command; never executes tasks
 *   web                alias for web-start
 *   web-start/web-stop start it detached (the startup hook and an action) / stop it
 *   web-restart        ask the session manager to restart the confirmed runtime
 *   web-apply          validate and apply the local linked source explicitly
 *   web-status         whether it is running and answering
 *   hook               startup only; obsolete events are ignored
 *   send ...           broadcast from the command line (see usage)
 *   list               print broadcasts and their executions
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { Store, defaultDbPath } from "./db.ts";
import { HerdrError, LOCAL, machineList } from "./herdr.ts";
import { runHook } from "./worker.ts";
import { applyLocalWeb, restartWeb, startWebDetached, stateDir, stopWeb, webStatus, webUrl } from "./web/launch.ts";

const USAGE = `usage:
  main.ts web | web-start | web-stop | web-restart | web-apply | web-status
  main.ts hook
  main.ts list
  main.ts send --prompt TEXT [--title TEXT] [--new [MACHINE/]KIND@DIR[*COUNT]]... [--custom JSON]...
  main.ts follow-up --broadcast ID --prompt TEXT [--execution ID]... [--new SPEC]... [--custom JSON]...
  main.ts confirm-startup --execution ID --terminal-id ID
      --custom JSON: {"machine":"local","kind":"custom","cwd":"~/repo","command":"my-agent","label":"My Agent","count":1}
      --execution selects a participant record printed by list; follow-up stays in that broadcast.
      --new    agents to start, e.g. --new claude@~/src/app*2 or --new gpu-box/codex@~/repo
      MACHINE is a saved machine's id or label; without one it is this machine.`;

function list(): void {
  const path = defaultDbPath(false);
  if (!existsSync(path)) return;
  const store = new Store(path, { readonly: true });
  for (const b of store.listBroadcasts()) {
    console.log(`#${b.id}  ${b.title}  (${b.total})  ${JSON.stringify(b.counts)}`);
    for (const e of store.executions(b.id)) {
      console.log(`    ${e.id}  round ${store.getRound(e.round_id)?.number}  ${e.machine_label}  ${e.agent_kind ?? "?"}  ${e.pane_id ?? "-"}  ${e.state}${e.note ? `  · ${e.note}` : ""}${e.error ? `  ! ${e.error}` : ""}`);
    }
  }
  store.close();
}

function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === name && args[i + 1] !== undefined) values.push(args[++i]!);
  return values;
}

async function apiRequest(path: string, body?: unknown): Promise<any> {
  const url = webUrl({ path: defaultDbPath(false) } as Store);
  const token = loadConfig().webToken;
  const headers: Record<string, string> = { "content-type": "application/json", origin: new URL(url).origin };
  if (token) headers.authorization = `Bearer ${token}`;
  let response: Response;
  try { response = await fetch(new URL(path, url), { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new Error("Broadcast Web 服务未运行，请先运行 web-start；没有保存或派发任务"); }
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result.error?.message ?? `HTTP ${response.status}`);
  return result;
}

function positiveId(value: string | undefined, flag: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${flag} requires a positive integer`);
  return id;
}

async function send(args: string[], follow = false): Promise<void> {
  if (args.includes("--to")) throw new Error("send --to 已移除：请使用 follow-up --broadcast ID --execution ID 在指定任务中继续广播");
  const prompt = flagValues(args, "--prompt")[0];
  if (!prompt?.trim()) throw new Error(`--prompt is required\n${USAGE}`);
  const broadcast = follow ? positiveId(flagValues(args, "--broadcast")[0], "--broadcast") : null;
  if (!follow && (args.includes("--execution") || args.includes("--broadcast"))) throw new Error("已有参与者请使用 follow-up --broadcast ID --execution ID");
  if (follow && args.includes("--title")) throw new Error("follow-up 不修改任务标题");
  const profiles = await machineList().catch(() => []);
  const machineOf = (spec: string) => {
    const slash = spec.indexOf("/");
    const head = slash > 0 ? spec.slice(0, slash) : "";
    const profile = head ? profiles.find(p => p.id === head || p.label === head) : undefined;
    return profile || head === LOCAL ? { id: profile?.id ?? LOCAL, rest: spec.slice(slash + 1) } : { id: LOCAL, rest: spec };
  };
  const fresh: { machine: string; kind: string; cwd: string; count?: number; command?: string; label?: string }[] = [];
  for (const spec of flagValues(args, "--new")) {
    const { id, rest } = machineOf(spec);
    const match = /^([a-z0-9_-]+)@(.+?)(?:\*(\d+))?$/.exec(rest);
    if (!match) throw new Error(`--new ${spec}: expected KIND@DIR[*COUNT]`);
    fresh.push({ machine: id, kind: match[1]!, cwd: match[2]!, count: Number(match[3] ?? 1) });
  }
  for (const value of flagValues(args, "--custom")) {
    let spec;
    try { spec = JSON.parse(value); } catch { throw new Error("--custom requires a JSON object"); }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("--custom requires a JSON object");
    const named = spec.machine ?? LOCAL;
    const machine = profiles.find(p => p.id === named || p.label === named)?.id ?? named;
    fresh.push({ machine, kind: "custom", cwd: spec.cwd, count: spec.count ?? 1, command: spec.command, ...(spec.label === undefined ? {} : { label: spec.label }) });
  }
  const ids = flagValues(args, "--execution").map(v => positiveId(v, "--execution"));
  if (!fresh.length && !ids.length) throw new Error("至少指定 --new、--custom 或 follow-up 的 --execution");
  let targets: { execution_id: number; terminal_id: string }[] = [];
  if (ids.length) {
    const state = await apiRequest("api/state");
    const b = state.state.broadcasts.find((b: any) => b.id === broadcast);
    if (!b) throw new Error("原广播记录不存在");
    targets = ids.map(id => {
      const e = b.executions.find((e: any) => e.id === id);
      if (!e?.terminal_id) throw new Error("所选执行记录不属于此任务或没有可用终端");
      return { execution_id: id, terminal_id: e.terminal_id };
    });
  }
  const result = await apiRequest(follow ? `api/broadcasts/${broadcast}/follow-up` : "api/broadcasts", {
    prompt, new: fresh, ...(follow ? { targets } : { title: flagValues(args, "--title")[0] }),
  });
  console.log(`broadcast #${result.id} round ${result.round_number}: ${result.executions} agents; execution IDs: ${result.execution_ids.join(", ")}`);
}

const [command = "", ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "worker": {
      console.log("独立 worker 已移除；广播由 Web 服务统一处理");
      break;
    }
    case "web":
    case "web-start": {
      const store = new Store();
      const result = await startWebDetached(store);
      console.log(result.how === "running" ? `already running: ${result.url}` : result.how === "started" ? `started: ${result.url}` : `could not start: ${result.error}`);
      store.close();
      if (result.how === "failed") process.exit(1);
      break;
    }
    case "web-stop": {
      const store = new Store();
      const how = await stopWeb(store);
      console.log(how === "stopped" ? "stopped" : how === "not-running" ? "not running" : "could not stop it: it is still running");
      store.close();
      break;
    }
    case "web-restart": {
      const store = new Store();
      const result = await restartWeb(store);
      console.log(result.how === "failed" ? `could not restart: ${result.error}` : `restarted: ${result.url}`);
      store.close();
      if (result.how === "failed") process.exit(1);
      break;
    }
    case "web-apply": {
      const store = new Store();
      const result = await applyLocalWeb(store);
      console.log(result.how === "failed" ? `could not apply local code: ${result.error}` : `applied local code: ${result.url}`);
      store.close();
      if (result.how === "failed") process.exit(1);
      break;
    }
    case "web-status": {
      const store = new Store();
      const status = await webStatus(store);
      console.log(
        status.pid === null
          ? `not running (${status.url})`
          : status.answering
            ? `running, pid ${status.pid}: ${status.url}`
            : `running, pid ${status.pid}, but ${status.url} does not answer: see ${join(stateDir(store), "web.log")}`,
      );
      store.close();
      break;
    }
    case "hook": {
      if (process.env.HERDR_PLUGIN_EVENT === "startup" && loadConfig().webAutostart) {
        const store = new Store();
        const result = await startWebDetached(store);
        store.close();
        console.log(`web page ${result.how}: ${result.url}${result.error ? ` (${result.error})` : ""}`);
      } else console.log(await runHook(null, process.env.HERDR_PLUGIN_EVENT));
      break;
    }
    case "follow-up":
      await send(rest, true);
      break;
    case "confirm-startup":
      await apiRequest(`api/executions/${positiveId(flagValues(rest, "--execution")[0], "--execution")}/confirm-startup`, { terminal_id: flagValues(rest, "--terminal-id")[0] });
      console.log("已确认本次启动；不会重复发送");
      break;
    case "send":
      await send(rest);
      break;
    case "list":
      list();
      break;
    default:
      console.error(USAGE);
      process.exit(2);
  }
} catch (error) {
  console.error(error instanceof HerdrError ? `herdr-broadcast: ${error.code}: ${error.message}` : `herdr-broadcast: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
