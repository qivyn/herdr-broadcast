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
import { Store, defaultDbPath, type NewExecution } from "./db.ts";
import { agentGet, HerdrError, LOCAL, machineList } from "./herdr.ts";
import { runHook } from "./worker.ts";
import { applyLocalWeb, restartWeb, startWebDetached, stateDir, stopWeb, webStatus, webUrl } from "./web/launch.ts";

const USAGE = `usage:
  main.ts web | web-start | web-stop | web-restart | web-apply | web-status
  main.ts hook
  main.ts list
  main.ts send --prompt TEXT [--title TEXT] [--to [MACHINE/]PANE]... [--new [MACHINE/]KIND@DIR[*COUNT]]...
      --to     an agent already running, e.g. --to w2:p1 or --to gpu-box/w1:p3
      --new    agents to start, e.g. --new claude@~/src/app*2 or --new gpu-box/codex@~/repo
      MACHINE is a saved machine's id or label; without one it is this machine.`;

function list(): void {
  const path = defaultDbPath(false);
  if (!existsSync(path)) return;
  const store = new Store(path, { readonly: true });
  for (const b of store.listBroadcasts()) {
    console.log(`#${b.id}  ${b.title}  (${b.total})  ${JSON.stringify(b.counts)}`);
    for (const e of store.executions(b.id)) {
      console.log(`    ${e.id}  ${e.machine_label}  ${e.agent_kind ?? "?"}  ${e.pane_id ?? "-"}  ${e.state}${e.note ? `  · ${e.note}` : ""}${e.error ? `  ! ${e.error}` : ""}`);
    }
  }
  store.close();
}

function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === name && args[i + 1] !== undefined) values.push(args[++i]!);
  return values;
}

async function send(args: string[]): Promise<void> {
  const prompt = flagValues(args, "--prompt")[0];
  if (!prompt) throw new Error(`--prompt is required\n${USAGE}`);
  const profiles = await machineList().catch(() => []);
  const machineOf = (spec: string): { id: string; label: string; rest: string } => {
    const slash = spec.indexOf("/");
    // a local folder may hold slashes: a machine prefix is the part before the first one, if it names a machine
    const head = slash > 0 ? spec.slice(0, slash) : "";
    const profile = head ? profiles.find((p) => p.id === head || p.label === head) : undefined;
    if (profile) return { id: profile.id, label: profile.label, rest: spec.slice(slash + 1) };
    if (head === LOCAL) return { id: LOCAL, label: "本机", rest: spec.slice(slash + 1) };
    return { id: LOCAL, label: "本机", rest: spec };
  };
  const executions: NewExecution[] = [];
  for (const spec of flagValues(args, "--to")) {
    const { id, label, rest } = machineOf(spec);
    const agent = await agentGet(id, rest);
    executions.push({ machine_id: id, machine_label: label, target_kind: "existing", agent_kind: agent.agent ?? agent.display_agent ?? "agent", agent_name: agent.name ?? null, cwd: agent.foreground_cwd ?? agent.cwd ?? null,
      pane_id: agent.pane_id, terminal_id: agent.terminal_id, workspace_id: agent.workspace_id, tab_id: agent.tab_id,
      session_kind: agent.agent_session?.kind ?? null, session_value: agent.agent_session?.value ?? null });
  }
  let slot = 0;
  for (const spec of flagValues(args, "--new")) {
    const { id, label, rest } = machineOf(spec);
    const match = /^([a-z0-9_-]+)@(.+?)(?:\*(\d+))?$/.exec(rest);
    if (!match) throw new Error(`--new ${spec}: expected KIND@DIR[*COUNT]`);
    for (let n = 0; n < Number(match[3] ?? "1"); n += 1) {
      slot += 1;
      executions.push({ machine_id: id, machine_label: label, target_kind: "new", agent_kind: match[1]!, cwd: match[2]!, slot });
    }
  }
  if (executions.length === 0) throw new Error(`no targets: give --to or --new\n${USAGE}`);
  const title = flagValues(args, "--title")[0] ?? prompt.split("\n").find((l) => l.trim())!.trim().slice(0, 60);
  const url = webUrl({ path: defaultDbPath(false) } as Store);
  const token = loadConfig().webToken;
  const headers: Record<string, string> = { "content-type": "application/json", origin: new URL(url).origin };
  if (token) headers.authorization = `Bearer ${token}`;
  let response: Response;
  try { response = await fetch(new URL("api/broadcasts", url), { method: "POST", headers, body: JSON.stringify({ title, prompt,
    targets: executions.filter(e => e.target_kind === "existing").map(e => ({ machine: e.machine_id, pane: e.pane_id, terminal_id: e.terminal_id, agent_kind: e.agent_kind, session_kind: e.session_kind, session_value: e.session_value })),
    new: executions.filter(e => e.target_kind === "new").map(e => ({ machine: e.machine_id, kind: e.agent_kind, cwd: e.cwd, count: 1 })),
  }) }); } catch { throw new Error("Broadcast Web 服务未运行，请先运行 web-start；没有保存或派发任务"); }
  const result = await response.json() as { id: number; executions: number; error?: { message: string } };
  if (!response.ok) throw new Error(result.error?.message ?? `HTTP ${response.status}`);
  console.log(`broadcast #${result.id}: ${result.executions} execution(s)`);
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
