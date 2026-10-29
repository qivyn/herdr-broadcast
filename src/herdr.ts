/**
 * The Herdr CLI is the plugin API. Every call goes through `HERDR_BIN_PATH` (the running
 * Herdr binary) and, for a saved SSH machine, the global `--machine <profile-id>` prefix, so
 * the same code drives Local and remote servers.
 */
import type { AgentInfo, PaneInfo, TabInfo, WorkspaceInfo } from "./herdr-types.ts";

/** The machine id this plugin uses for the server it runs under. */
export const LOCAL = "local";

export class HerdrError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HerdrError";
  }
}

export interface CallOptions {
  /** LOCAL, or a saved machine profile id */
  machine?: string;
  /** kills the call after this long; herdr's own waits get their own --timeout */
  timeoutMs?: number;
  /** kills the call early, e.g. when the pane already shows the agent could not start */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

/** Prefix that routes a call: `--machine <id>` for a saved machine, `--session <name>` for a test session. */
export function routeArgs(machine: string | undefined): string[] {
  if (machine && machine !== LOCAL) return ["--machine", machine];
  const session = process.env.HERDR_BROADCAST_SESSION;
  return session ? ["--session", session] : [];
}

export interface RawResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs herdr with argv (never a shell). */
export async function runHerdr(args: string[], opts: CallOptions = {}): Promise<RawResult> {
  const argv = [herdrBin(), ...routeArgs(opts.machine), ...args];
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const aborted = () => proc.kill();
  opts.signal?.addEventListener("abort", aborted, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (opts.signal?.aborted) throw new HerdrError("aborted", `herdr ${args.slice(0, 2).join(" ")} was stopped`);
    if (timedOut) throw new HerdrError("timeout", `herdr ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs}ms`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", aborted);
  }
}

function errorFrom(raw: RawResult, args: string[]): HerdrError {
  for (const text of [raw.stderr, raw.stdout]) {
    for (const line of text.split("\n").reverse()) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const frame = JSON.parse(trimmed) as { error?: { code?: string; message?: string } };
        if (frame.error) return new HerdrError(frame.error.code ?? "herdr_error", frame.error.message ?? "herdr request failed");
      } catch {
        /* not a frame */
      }
    }
  }
  const message = (raw.stderr.trim() || raw.stdout.trim() || `exit ${raw.code}`).split("\n").slice(-3).join(" ");
  return new HerdrError(raw.code === 2 ? "usage" : "herdr_error", `herdr ${args.slice(0, 2).join(" ")}: ${message}`);
}

/** A JSON command: returns the parsed stdout (the whole frame, or a bare array for list --json). */
export async function herdrJson<T = unknown>(args: string[], opts: CallOptions = {}): Promise<T> {
  const raw = await runHerdr(args, opts);
  if (raw.code !== 0) throw errorFrom(raw, args);
  const text = raw.stdout.trim();
  if (text === "") return {} as T;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.error) {
      throw new HerdrError(parsed.error.code ?? "herdr_error", parsed.error.message ?? "herdr request failed");
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof HerdrError) throw error;
    throw new HerdrError("bad_output", `herdr ${args.slice(0, 2).join(" ")} printed something that is not JSON: ${text.slice(0, 200)}`);
  }
}

/** A socket-API command: returns `.result`. */
export async function herdrResult<T = unknown>(args: string[], opts: CallOptions = {}): Promise<T> {
  const frame = await herdrJson<{ result?: T }>(args, opts);
  return (frame.result ?? (frame as unknown as T));
}

// ---- agents -------------------------------------------------------------------------------

export async function agentList(machine: string): Promise<AgentInfo[]> {
  const result = await herdrResult<{ agents?: AgentInfo[] }>(["agent", "list"], { machine });
  return result.agents ?? [];
}

export async function agentGet(machine: string, target: string): Promise<AgentInfo> {
  const result = await herdrResult<{ agent: AgentInfo }>(["agent", "get", target], { machine });
  return result.agent;
}

export async function agentStart(machine: string, opts: { name: string; kind: string; pane: string; timeoutMs?: number; args?: string[]; signal?: AbortSignal }): Promise<AgentInfo | null> {
  const timeout = opts.timeoutMs ?? 60_000;
  const argv = ["agent", "start", opts.name, "--kind", opts.kind, "--pane", opts.pane, "--timeout", String(timeout)];
  if (opts.args && opts.args.length > 0) argv.push("--", ...opts.args);
  const result = await herdrResult<{ agent?: AgentInfo }>(argv, { machine, timeoutMs: timeout + 15_000, signal: opts.signal });
  return result.agent ?? null;
}

/** Herdr pins this wait to the current agent occupant; replacement/exit cannot satisfy it. */
export async function agentWaitReady(machine: string, target: string, timeoutMs: number, signal: AbortSignal): Promise<AgentInfo> {
  const result = await herdrResult<{ agent: AgentInfo }>(["agent", "wait", target, "--until", "idle", "--until", "done", "--timeout", String(timeoutMs)],
    { machine, timeoutMs: timeoutMs + 15_000, signal });
  return result.agent;
}

/** Submits text + Enter. Returns once both are written; it does not wait for the turn. */
export async function agentPrompt(machine: string, target: string, text: string): Promise<AgentInfo | null> {
  const result = await herdrResult<{ agent?: AgentInfo }>(["agent", "prompt", target, text], { machine, timeoutMs: 30_000 });
  return result.agent ?? null;
}

export async function agentSendKeys(machine: string, target: string, keys: string[]): Promise<void> {
  await herdrResult(["agent", "send-keys", target, ...keys], { machine });
}

export async function paneSendText(machine: string, pane: string, text: string): Promise<void> {
  await herdrResult(["pane", "send-text", pane, text], { machine });
}

export async function paneSendKeys(machine: string, pane: string, keys: string[]): Promise<void> {
  await herdrResult(["pane", "send-keys", pane, ...keys], { machine });
}

export async function agentFocus(machine: string, target: string): Promise<void> {
  await herdrResult(["agent", "focus", target], { machine });
}

export async function agentRename(machine: string, target: string, name: string): Promise<void> {
  await herdrResult(["agent", "rename", target, name], { machine });
}

/**
 * Output: `recent-unwrapped` for history, `visible` for the screen as it stands now; `ansi` keeps
 * the colors and text styles the agent drew with.
 */
export async function agentRead(machine: string, target: string, lines = 60, source: "recent-unwrapped" | "visible" = "recent-unwrapped", format: "text" | "ansi" = "text"): Promise<string> {
  const args = ["agent", "read", target, "--source", source, ...(source === "visible" ? [] : ["--lines", String(lines)]), "--format", format];
  const raw = await runHerdr(args, { machine });
  if (raw.code !== 0) throw errorFrom(raw, args);
  const text = raw.stdout;
  try {
    const found = findText(JSON.parse(text));
    if (found !== null) return found;
  } catch {
    /* plain text output */
  }
  return text;
}

/**
 * The pane's text as it stands (`recent` history, `visible` screen only). Not an agent read: a
 * pane whose agent never came up — a command the machine does not have — still shows its shell.
 */
export async function paneRead(machine: string, pane: string, lines = 40, source: "visible" | "recent" = "recent"): Promise<string> {
  const args = ["pane", "read", pane, "--source", source, ...(source === "visible" ? [] : ["--lines", String(lines)]), "--format", "text", "--raw"];
  const raw = await runHerdr(args, { machine });
  if (raw.code !== 0) throw errorFrom(raw, args);
  return raw.stdout;
}

function findText(value: unknown): string | null {  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  for (const key of ["result", "read", "agent_read", "pane_read"]) {
    const nested = findText(record[key]);
    if (nested !== null) return nested;
  }
  return null;
}

// ---- layout -------------------------------------------------------------------------------

export interface Created {
  workspace?: WorkspaceInfo;
  tab?: TabInfo;
  root_pane?: PaneInfo;
}

export async function workspaceList(machine: string): Promise<WorkspaceInfo[]> {
  const result = await herdrResult<{ workspaces?: WorkspaceInfo[] }>(["workspace", "list"], { machine });
  return result.workspaces ?? [];
}

export async function paneList(machine: string, workspace?: string): Promise<PaneInfo[]> {
  const result = await herdrResult<{ panes?: PaneInfo[] }>(["pane", "list", ...(workspace ? ["--workspace", workspace] : [])], { machine });
  return result.panes ?? [];
}

export async function workspaceCreate(machine: string, opts: { cwd: string; label: string }): Promise<Created> {
  return herdrResult<Created>(["workspace", "create", "--cwd", opts.cwd, "--label", opts.label, "--no-focus"], { machine });
}

export async function tabCreate(machine: string, opts: { workspace: string; cwd: string; label: string }): Promise<Created> {
  return herdrResult<Created>(["tab", "create", "--workspace", opts.workspace, "--cwd", opts.cwd, "--label", opts.label, "--no-focus"], { machine });
}

export async function workspaceFocus(machine: string, workspace: string): Promise<void> {
  await herdrResult(["workspace", "focus", workspace], { machine });
}

export async function tabFocus(machine: string, tab: string): Promise<void> {
  await herdrResult(["tab", "focus", tab], { machine });
}

export async function tabRename(machine: string, tab: string, label: string): Promise<void> {
  await herdrResult(["tab", "rename", tab, label], { machine });
}

/**
 * Opens a plugin pane with focus and returns Herdr's answer as printed. An action should pass it on
 * to its stdout: herdr-web-ui reads the `plugin_pane_opened` line from an action's output to
 * select the pane it opened in the browser too.
 */
export async function pluginPaneOpen(plugin: string, entrypoint: string, placement?: string): Promise<string> {
  const args = ["plugin", "pane", "open", "--plugin", plugin, "--entrypoint", entrypoint, ...(placement ? ["--placement", placement] : []), "--focus"];
  const raw = await runHerdr(args);
  if (raw.code !== 0) throw errorFrom(raw, args);
  return raw.stdout;
}

// ---- machines -----------------------------------------------------------------------------

/** One saved SSH machine profile, as `herdr machine list --json` prints it. */
export interface MachineProfile {
  id: string;
  label: string;
  target: string;
  session: string;
  enabled: boolean;
}

export async function machineList(): Promise<MachineProfile[]> {
  const parsed = await herdrJson<unknown>(["machine", "list", "--json"]);
  const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { result?: { machines?: unknown } }).result?.machines) ? (parsed as { result: { machines: unknown[] } }).result.machines : [];
  return rows.flatMap((row): MachineProfile[] => {
    if (!row || typeof row !== "object") return [];
    const value = row as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id) return [];
    return [{
      id: value.id,
      label: typeof value.label === "string" ? value.label : value.id,
      target: typeof value.target === "string" ? value.target : "",
      session: typeof value.session === "string" ? value.session : "default",
      enabled: value.enabled !== false,
    }];
  });
}

/** `herdr machine status --json`: kept as parsed JSON, the page shows what it says. */
export async function machineStatus(id?: string): Promise<unknown> {
  return herdrJson(["machine", "status", ...(id ? [id] : []), "--json"], { timeoutMs: 45_000 });
}

/** A machine command: these take no --json and say what they did in plain text. */
async function machineCommand(args: string[]): Promise<void> {
  const raw = await runHerdr(args);
  if (raw.code !== 0) throw errorFrom(raw, args);
}

export async function machineSetEnabled(id: string, enabled: boolean): Promise<void> {
  await machineCommand(["machine", enabled ? "enable" : "disable", id]);
}

export async function machineRename(id: string, label: string): Promise<void> {
  await machineCommand(["machine", "rename", id, "--label", label]);
}

export async function machineRemove(id: string): Promise<void> {
  await machineCommand(["machine", "remove", id]);
}

/** argv for the interactive machine commands, which must run in a real terminal. */
export function machineAddArgv(target: string, opts: { label?: string; remoteSession?: string }): string[] {
  const argv = [herdrBin(), "machine", "add", target];
  if (opts.label) argv.push("--label", opts.label);
  if (opts.remoteSession) argv.push("--remote-session", opts.remoteSession);
  return argv;
}

export function machineReconnectArgv(id: string): string[] {
  return [herdrBin(), "machine", "reconnect", id];
}
