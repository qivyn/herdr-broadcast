#!/usr/bin/env bun
/**
 * A stand-in for the herdr CLI, for tests: keeps a tiny server state in $FAKE_HERDR_STATE (JSON)
 * and answers the commands the plugin uses with Herdr's JSON shapes. Tests drive agent states by
 * editing the same file. `--machine <id>` selects a separate state per machine.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

interface Agent {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  agent: string;
  name: string | null;
  agent_status: string;
  state_change_seq: number;
  completion_seq: number | null;
  cwd: string;
  agent_session?: { agent: string; kind: string; source: string; value: string } | null;
  /** reports itself through `pane report-agent`: Herdr's agent prompt refuses it */
  custom?: boolean;
}

interface ServerState {
  omitSessionReports?: boolean;
  next: number;
  workspaces: { workspace_id: string; label: string; active_tab_id: string }[];
  tabs: { tab_id: string; workspace_id: string; label: string }[];
  panes: { pane_id: string; tab_id: string; workspace_id: string; terminal_id: string; cwd: string }[];
  agents: Agent[];
  prompts: { pane_id: string; text: string }[];
  /** text written with pane send-text */
  typed?: { pane_id: string; text: string }[];
  /** error codes the next calls of a command answer with, e.g. {"agent start": ["pane_busy"]} */
  failNext?: Record<string, string[]>;
  unreachable?: boolean;
  /** how long `agent prompt` takes to answer, as a slow paste does */
  promptDelayMs?: number;
  /** Metadata returned with this submission; null simulates older responses without an agent. */
  promptReply?: Partial<Agent> | null;
  /** A session switch between agent.prompt refusal and raw-input fallback. */
  promptRefusalSession?: Agent["agent_session"];
  startDelayMs?: number;
  /** agent kinds this machine has no program for: their start fails in the shell, as Herdr 0.9.5 shows it */
  missingKinds?: string[];
  /** what each pane shows, for pane read */
  screens?: Record<string, string>;
}

interface State {
  machines: { id: string; label: string; target: string; session: string; enabled: boolean }[];
  servers: Record<string, ServerState>;
  /** what `machine add <target>` finds there: no matching Herdr, a server to stop first */
  remotes?: Record<string, { install?: boolean; stopServer?: boolean }>;
}

const file = process.env.FAKE_HERDR_STATE!;
let args = process.argv.slice(2);
let machine = "local";
if (args[0] === "--machine") {
  machine = args[1]!;
  args = args.slice(2);
}
if (process.env.FAKE_HERDR_LOG) appendFileSync(process.env.FAKE_HERDR_LOG, `${machine} ${JSON.stringify(args)}\n`);
const command = `${args[0]} ${args[1]}`;

/** Reads must not write: concurrent calls would put back a stale copy over another's change. */
const MUTATING = new Set(["agent prompt", "agent start", "agent rename", "workspace create", "tab create", "pane send-text", "pane send-keys", "pane close", "machine rename", "machine enable", "machine disable", "machine remove"]);
const lockDir = `${file}.lock`;
let locked = false;
/** Mutations (and any call that may consume an injected failure) hold a lock from read to write. */
function lock(): void {
  for (let i = 0; i < 2000; i += 1) {
    try {
      mkdirSync(lockDir);
      locked = true;
      return;
    } catch {
      Bun.sleepSync(2);
    }
  }
  throw new Error("fake herdr: lock timeout");
}
function unlock(): void {
  if (locked) rmSync(lockDir, { recursive: true, force: true });
  locked = false;
}
// Cancellation can arrive during the initial locked read, before `agent wait`
// releases it. Let JS finish that critical section and release our lock on exit.
process.on("exit", unlock);
process.on("SIGTERM", () => process.exit(143));
lock();
const state: State = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { machines: [], servers: {} };
const server: ServerState = (state.servers[machine] ??= { next: 1, workspaces: [], tabs: [], panes: [], agents: [], prompts: [] });
const injected = server.failNext?.[command];
const injectedNow = !!injected && injected.length > 0;
if (!MUTATING.has(command) && !injectedNow) unlock();

function save(): void {
  if (MUTATING.has(command) || injectedNow) writeFileSync(file, JSON.stringify(state, null, 2));
  unlock();
}

function ok(result: unknown): never {
  save();
  process.stdout.write(JSON.stringify({ id: `cli:${args[0]}:${args[1]}`, result }) + "\n");
  process.exit(0);
}

function fail(code: string, message = code): never {
  save();
  process.stderr.write(JSON.stringify({ id: `cli:${args[0]}:${args[1]}`, error: { code, message } }) + "\n");
  process.exit(1);
}

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

if (injectedNow) {
  const failure = injected!.shift()!;
  if (command === "terminal session" && failure.startsWith("frame:")) {
    save();
    process.stdout.write(JSON.stringify({ type: "terminal.closed", reason: failure.slice(6) }) + "\n");
    process.exit(0);
  }
  fail(failure);
}
if (machine !== "local" && server.unreachable) fail("machine_unreachable", "ssh: connect to host failed");

function newPane(workspace_id: string, tab_id: string, cwd: string) {
  const n = server.next++;
  const pane = { pane_id: `${workspace_id}:p${n}`, tab_id, workspace_id, terminal_id: `term_${machine}_${n}`, cwd };
  server.panes.push(pane);
  return pane;
}

function findAgent(target: string): Agent {
  const agent = server.agents.find((a) => a.pane_id === target || a.terminal_id === target || a.name === target);
  if (!agent) fail("agent_not_found", `no agent ${target}`);
  return agent;
}

/** A [y/N] question as Herdr asks it, in a terminal only. */
async function ask(question: string, defaultYes: boolean): Promise<boolean> {
  process.stdout.write(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
  for await (const line of console) {
    const a = line.trim().toLowerCase();
    return a === "" ? defaultYes : a === "y" || a === "yes";
  }
  return false;
}

switch (command) {
  case "terminal session": {
    if (args[2] !== "control") fail("unsupported", "expected control");
    findAgent(args[3]!);
    let cols = Number(flag("--cols") || 80), rows = Number(flag("--rows") || 24), seq = 0;
    const frame = (text: string) => process.stdout.write(JSON.stringify({ type: "terminal.frame", encoding: "ansi", seq: ++seq, full: seq === 1, width: cols, height: rows, bytes: Buffer.from(text).toString("base64") }) + "\n");
    frame("\x1b[2J\x1b[HREADY 中文🙂\r\n");
    for await (const line of console) {
      const message = JSON.parse(line);
      if (message.type === "terminal.input") {
        if (message.text === "__FAKE_FLOOD__") for (let i = 0; i < 12; i++) frame("x".repeat(50_000));
        else if (message.text === "__FAKE_CLOSED__") { process.stdout.write(JSON.stringify({ type: "terminal.closed", reason: "controller taken elsewhere" }) + "\n"); process.exit(0); }
        else frame(message.text);
      }
      else if (message.type === "terminal.resize") { cols = message.cols; rows = message.rows; frame(`SIZE ${cols}x${rows}`); }
      else if (message.type === "terminal.scroll") frame(`SCROLL ${message.direction} ${message.lines}`);
      else if (message.type === "terminal.release") break;
    }
    if (process.env.FAKE_HERDR_LOG) appendFileSync(process.env.FAKE_HERDR_LOG + ".closed", args[3]! + "\n");
    process.exit(0);
  }

  case "machine add": {
    // no lock held while it waits on answers: the page keeps reading meanwhile
    const target = args[2]!;
    const remote = state.remotes?.[target] ?? {};
    const tty = !!process.stdin.isTTY;
    if (remote.install) {
      if (!tty) fail("herdr_error", 'matching remote herdr 0.9.5 is not installed at "$HOME/.local/bin/herdr"; run from an interactive terminal to approve installation; machine was not saved');
      process.stdout.write(`matching herdr 0.9.5 is not installed on ${target} (session default) for linux-x86_64.\n`);
      if (!(await ask('Install the 0.9.5 stable asset for linux-x86_64 to "$HOME/.local/bin/herdr"?', true))) {
        process.stderr.write("remote herdr install cancelled\n");
        process.exit(1);
      }
      process.stdout.write("\x1b[32minstalled remote herdr at ~/.local/bin/herdr\x1b[0m\n");
    }
    if (remote.stopServer && !(await ask("stop and update the remote server, then continue attaching?", false))) {
      process.stderr.write("remote herdr server stop cancelled\n");
      process.exit(1);
    }
    lock();
    const now: State = JSON.parse(readFileSync(file, "utf8"));
    const id = `m-${now.machines.length + 1}`;
    now.machines.push({ id, label: flag("--label") ?? target, target, session: flag("--remote-session") ?? "default", enabled: true });
    now.servers[id] = { next: 1, workspaces: [], tabs: [], panes: [], agents: [], prompts: [] };
    if (now.remotes) delete now.remotes[target];
    writeFileSync(file, JSON.stringify(now, null, 2));
    unlock();
    process.stdout.write(`saved machine ${id}\n`);
    process.exit(0);
  }
  case "machine list":
    process.stdout.write(JSON.stringify(state.machines) + "\n");
    process.exit(0);
  case "machine status":
    process.stdout.write(JSON.stringify(state.machines.map((m) => ({ id: m.id, label: m.label, state: state.servers[m.id]?.unreachable ? "unreachable" : "reachable" }))) + "\n");
    process.exit(0);
  case "machine rename":
  case "machine enable":
  case "machine disable":
  case "machine remove": {
    const id = args[2]!;
    const m = state.machines.find((x) => x.id === id);
    if (!m) fail("machine_not_found", `no machine ${id}`);
    if (args[1] === "rename") m.label = flag("--label") ?? m.label;
    else if (args[1] === "remove") state.machines = state.machines.filter((x) => x.id !== id);
    else m.enabled = args[1] === "enable";
    writeFileSync(file, JSON.stringify(state, null, 2));
    unlock();
    // as Herdr says it: a sentence, not JSON
    process.stdout.write(`${{ rename: "Renamed", remove: "Removed", enable: "Enabled", disable: "Disabled" }[args[1]!]} SSH machine ${id}.\n`);
    process.exit(0);
  }
  case "agent list":
    ok({ type: "agent_list", agents: server.agents.map((a) => ({ ...a, focused: false })) });
  case "agent get":
    ok({ type: "agent_info", agent: { ...findAgent(args[2]!), focused: false } });
  case "agent wait": {
    const original = findAgent(args[2]!);
    const statuses = args.flatMap((arg, i) => arg === "--until" ? [args[i + 1]!] : []);
    const until = Date.now() + Number(flag("--timeout") ?? 300_000);
    while (true) {
      const current = (JSON.parse(readFileSync(file, "utf8")) as State).servers[machine];
      if (!current || current.unreachable) fail("machine_unreachable");
      const agent = current.agents.find(a => a.pane_id === original.pane_id && a.terminal_id === original.terminal_id
        && a.name === original.name && a.agent === original.agent);
      if (!agent) fail("agent_not_running");
      if (statuses.includes(agent.agent_status)) ok({ type: "agent_wait", agent: { ...agent, focused: false } });
      if (Date.now() >= until) fail("timeout");
      await Bun.sleep(10);
    }
  }
  case "agent rename": {
    const agent = findAgent(args[2]!);
    const name = args[3]!;
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) fail("invalid_agent_name");
    if (server.agents.some((a) => a !== agent && a.name === name)) fail("agent_name_taken");
    agent.name = name;
    ok({ agent });
  }
  case "agent prompt": {
    const agent = findAgent(args[2]!);
    if (agent.agent_status === "blocked") fail("agent_blocked");
    if (agent.custom) {
      if (server.promptRefusalSession) agent.agent_session = server.promptRefusalSession;
      fail("agent_not_ready", `agent ${agent.pane_id} is not an active named agent`);
    }
    server.prompts.push({ pane_id: agent.pane_id, text: args[3]! });
    if (server.promptDelayMs) await Bun.sleep(server.promptDelayMs);
    ok({ type: "agent_prompted", ...(server.promptReply === null ? {} : { agent: { ...agent, focused: false, ...server.promptReply } }) });
  }
  case "pane send-text": {
    const pane = server.panes.find((p) => p.pane_id === args[2]) ?? fail("pane_not_found");
    (server.typed ??= []).push({ pane_id: pane.pane_id, text: args[3]! });
    ok({ type: "ok" });
  }
  case "pane send-keys": {
    const pane = server.panes.find((p) => p.pane_id === args[2]) ?? fail("pane_not_found");
    const typed = (server.typed ??= []).filter((t) => t.pane_id === pane.pane_id).pop();
    if (args.slice(3).includes("enter") && typed) server.prompts.push({ pane_id: pane.pane_id, text: typed.text });
    ok({ type: "ok" });
  }
  case "agent focus":
  case "agent send-keys":
    findAgent(args[2]!);
    ok({ type: "ok" });
  case "agent read":
    findAgent(args[2]!);
    ok({ type: "pane_read", read: { text: "fake output\nline 2\n" } });
  case "agent start": {
    const name = args[2]!;
    const pane = server.panes.find((p) => p.pane_id === flag("--pane"));
    if (!pane) fail("pane_not_found");
    const kind = flag("--kind")!;
    if (server.missingKinds?.includes(kind)) {
      // Herdr lists a placeholder while it waits; the shell says at once that there is no such command,
      // and Herdr still waits out its whole timeout before it answers
      server.agents.push({ pane_id: pane.pane_id, tab_id: pane.tab_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id, name, agent_status: "unknown", state_change_seq: 0, completion_seq: null, cwd: pane.cwd, launch_pending: true } as unknown as Agent);
      (server.screens ??= {})[pane.pane_id] = `${server.screens?.[pane.pane_id] ?? "user@box:~$ "}${kind}\nbash: ${kind}: command not found\nuser@box:~$ `;
      writeFileSync(file, JSON.stringify(state, null, 2));
      unlock();
      await Bun.sleep(Number(flag("--timeout") ?? 30_000));
      process.stderr.write(JSON.stringify({ id: "cli:agent:start", error: { code: "timeout", message: "timed out waiting for agent startup" } }) + "\n");
      process.exit(1);
    }
    const n = server.next++;
    const agent: Agent = { pane_id: pane.pane_id, tab_id: pane.tab_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id, agent: kind, name, agent_status: process.env.FAKE_START_BLOCKED ? "blocked" : "idle", state_change_seq: n, completion_seq: null, cwd: pane.cwd };
    const agentArgs = args.slice(args.indexOf("--") + 1);
    if (!server.omitSessionReports && args.includes("--") && ["--resume", "resume", "--session"].includes(agentArgs[0]!) && agentArgs[1]) {
      agent.agent_session = { agent: agent.agent, kind: agentArgs[1].startsWith("/") ? "path" : "id", source: "integration", value: agentArgs[1] };
    }
    server.agents.push(agent);
    if (process.env.FAKE_START_BLOCKED) fail("agent_not_ready");
    if (server.startDelayMs) await Bun.sleep(server.startDelayMs);
    ok({ type: "agent_started", agent: { ...agent, focused: false } });
  }
  case "pane list":
    ok({ panes: server.panes.map((p) => ({ ...p, agent_status: server.agents.find((a) => a.pane_id === p.pane_id)?.agent_status ?? "unknown" })) });
  case "pane read": {
    const pane = server.panes.find((p) => p.pane_id === args[2]) ?? fail("pane_not_found");
    unlock();
    process.stdout.write(server.screens?.[pane.pane_id] ?? "user@box:~$ ");
    process.exit(0);
  }
  case "pane close": {
    const pane = server.panes.find(p => p.pane_id === args[2]) ?? fail("pane_not_found");
    server.panes = server.panes.filter(p => p !== pane);
    server.agents = server.agents.filter(a => a.pane_id !== pane.pane_id);
    ok({ type: "ok" });
  }
  case "workspace list":
    ok({ type: "workspace_list", workspaces: server.workspaces });
  case "workspace create": {
    const id = `w${server.next++}`;
    const tab = { tab_id: `${id}:t1`, workspace_id: id, label: "1" };
    const workspace = { workspace_id: id, label: flag("--label") ?? id, active_tab_id: tab.tab_id };
    server.workspaces.push(workspace);
    server.tabs.push(tab);
    const root = newPane(id, tab.tab_id, flag("--cwd") ?? "/");
    ok({ type: "workspace_created", workspace, tab, root_pane: { ...root, agent_status: "unknown" } });
  }
  case "tab create": {
    const workspace = server.workspaces.find((w) => w.workspace_id === flag("--workspace"));
    if (!workspace) fail("workspace_not_found");
    const tab = { tab_id: `${workspace.workspace_id}:t${server.next++}`, workspace_id: workspace.workspace_id, label: flag("--label") ?? "" };
    server.tabs.push(tab);
    const root = newPane(workspace.workspace_id, tab.tab_id, flag("--cwd") ?? "/");
    ok({ type: "tab_created", tab, root_pane: { ...root, agent_status: "unknown" } });
  }
  case "tab rename":
  case "tab focus":
  case "workspace focus":
    ok({ type: "ok" });
  case "plugin list":
    ok({ plugins: process.env.HERDR_PLUGIN_ROOT ? [{ plugin_id: "herdr-broadcast", plugin_root: process.env.HERDR_PLUGIN_ROOT, version: "0.3.0", source: { kind: "local" }, events: JSON.parse(process.env.FAKE_PLUGIN_EVENTS || "[]") }] : [] });
  case "plugin action":
    ok({ type: "plugin_action_invoked" });
  default:
    fail("usage", `fake herdr does not know: ${args.join(" ")}`);
}
