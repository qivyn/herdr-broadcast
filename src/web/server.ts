/**
 * The broadcast web page: a small HTTP server for the browser and phone, next to herdr-web-ui.
 * It streams interactive terminals over authenticated, same-origin WebSockets.
 *
 * Who gets in still matters:
 * - it listens on 127.0.0.1 unless told otherwise;
 * - a request must name this server in its Host (no DNS rebinding) and, when it changes
 *   anything, come from this page's own origin (no other site posting to localhost);
 * - with `web_token` set, every request needs the token (cookie after `?token=` once, or a
 *   Bearer header): set it before exposing the port through Tailscale or a proxy.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Updater, type UpdaterOptions, type UpdateController } from "../update.ts";
import { terminalAssets } from "./terminal-assets.ts";
import { loadConfig } from "../config.ts";
import { ACTIVE_STATES, pidAlive, type Execution, type NewExecution, type Store } from "../db.ts";
import { Engine, READY, resolveCwd, submitPrompt, type Machine } from "../engine.ts";
import { agentGet, agentRead, agentRename, herdrJson, HerdrError, LOCAL, paneSendKeys, paneSendText, machineList, machineRemove, machineRename, machineSetEnabled, machineStatus, workspaceFocus } from "../herdr.ts";
import { isDir, listDirs } from "./dirs.ts";
import { TerminalBridge, terminalGeometry, type TerminalSocketData } from "./terminal.ts";
import { AddJobs } from "./add-job.ts";
import { addCommand, checkTarget, configEntry, generateKey, localHerdrVersion, localKey, openAddTerminal, parseMachineStatus, parseSession, parseTarget, suggestEntryName, tightenKey, trustHostKey, verifyLogin, webUiMachines, writeConfigEntry, type MachineHealth } from "./ssh.ts";
import { sanitizeKeepStyle } from "../text.ts";
import { AGENTS, AGENT_KINDS, DEFAULT_AGENT_KINDS, validCwd } from "../agents.ts";
import { AgentEnvironments, type EnvironmentRunner } from "../agent-environment.ts";
import { confirmManual, manualBindingKey, manualValid, refreshManual } from "../manual-session.ts";
import { DEFAULT_WEB_URL, webLinkQuery } from "../weblink.ts";
import { Conversations, continuationInfo, RestoreUnavailableError } from "../continuation.ts";
import { continuationKey, resumeIdentityIssue } from "../conversation-target.ts";

export const WEB_LOCK = "web";
export const DEFAULT_WEB_PORT = 7318;
const HEARTBEAT_MS = 5_000;
const PUSH_EVERY_MS = 1_000;
const WEB_UI_CHECK_MS = 30_000;
/** how long a `herdr machine status` answer is reused: it connects to every machine */
const HEALTH_TTL_MS = 20_000;
const WEB_UI_PLUGIN = "devswha.herdr-web-ui";
/** how far back an agent's panel reaches */
const SCREEN_LINES = 300;
/** the page's own script and styles only; nothing frames it */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Whether herdr-web-ui is there to open an agent's conversation in. It is optional: without it
 * the page offers to show the agent in Herdr instead. Installed is read from Herdr's plugin list;
 * running from its health check, which is what decides whether links are offered.
 */
export interface WebUiStatus {
  installed: boolean;
  running: boolean;
}

export async function detectWebUi(baseUrl: string = loadConfig().webUrl ?? DEFAULT_WEB_URL): Promise<WebUiStatus> {
  let installed = false;
  try {
    const list = await herdrJson<{ result?: { plugins?: { plugin_id?: string }[] } }>(["plugin", "list", "--json"], { timeoutMs: 5_000 });
    installed = (list.result?.plugins ?? []).some((p) => p.plugin_id === WEB_UI_PLUGIN);
  } catch {
    /* an older herdr or a failed call: running still decides */
  }
  let running = false;
  try {
    // a token-protected herdr-web-ui answers 401 and is running all the same
    const response = await fetch(new URL("api/health", baseUrl), { signal: AbortSignal.timeout(1_500) });
    running = response.ok || response.status === 401;
  } catch {
    running = false;
  }
  return { installed, running };
}

export interface WebOptions {
  host: string;
  port: number;
  token: string | null;
  /** extra Host names to accept, e.g. a Tailscale name */
  hosts: string[];
  /** look for a newer plugin version on a timer; tests leave it off */
  checkUpdates?: boolean;
  paused?: boolean;
  runtime?: { revision: string | null; hash: string; database: string; bootId: string };
}

export function webOptions(): WebOptions {
  const config = loadConfig();
  return {
    host: config.webHost ?? "127.0.0.1",
    port: config.webPort ?? DEFAULT_WEB_PORT,
    token: config.webToken,
    hosts: config.webHosts,
    checkUpdates: true,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** For browsers that send no Sec-Fetch-Site: the Origin must be this very host. "null" never is. */
function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The workspace a machine opens on: the one with the focused agent there, else its first. */
function machineWorkspace(view: ReturnType<Engine["view"]>) {
  const focused = view?.agents.find((a) => a.focused);
  return view?.workspaces.find((w) => w.workspace_id === focused?.workspace_id) ?? view?.workspaces[0];
}

/** Why a machine cannot be opened (in Herdr or herdr-web-ui) right now, or null. */
function machineUnavailable(m: Machine, view: ReturnType<Engine["view"]>): string | null {
  return !m.enabled ? "请先启用这台机器" : view?.error ? "机器暂时连接不上，请先检查连接"
    : !view?.at ? "正在读取机器的工作区" : !machineWorkspace(view) ? "机器暂无工作区，请先在 Herdr 中创建工作区" : null;
}

/** The page's view of everything: machines, broadcasts and each one's executions. */
export function snapshot(store: Store, engine: Engine) {
  return {
    machines: engine.machines.map((m) => {
      const view = engine.view(m.id);
      const workspace = machineWorkspace(view);
      const unavailable = machineUnavailable(m, view);
      return {
        id: m.id, label: m.label, enabled: m.enabled, target: m.target,
        web_link: !unavailable && workspace ? webLinkQuery({ machineId: m.id, workspaceId: workspace.workspace_id, workspaceLabel: workspace.label, paneId: null }) : null,
        web_link_reason: unavailable,
      };
    }),
    machinesError: engine.machinesError,
    broadcasts: store.listBroadcasts().map((b) => ({
      ...b,
      rounds: store.rounds(b.id),
      executions: store.executions(b.id).map((original) => {
        const info = continuationInfo(store, engine, original);
        const e = info.execution;
        const liveAgent = ["live", "restoring", "starting", "shell"].includes(info.terminal_state)
          ? engine.view(e.machine_id)?.agents.find((a) => a.pane_id === e.pane_id && a.terminal_id === e.terminal_id) : undefined;
        return {
        id: e.id, round_id: e.round_id, machine_id: e.machine_id, machine_label: engine.machineLabel(e.machine_id), target_kind: e.target_kind, agent_kind: e.agent_kind,
        agent_status: liveAgent?.agent_status ?? null,
        agent_name: liveAgent ? liveAgent.name ?? null : e.agent_name, cwd: e.cwd, pane_id: e.pane_id, workspace_label: e.workspace_label, state: e.state,
        note: e.note, error: e.error, session_kind: e.session_kind, session_value: e.session_value, sent_at: e.sent_at, finished_at: e.finished_at,
        manual_session: store.continuation(continuationKey(e))?.manual_required === true || e.agent_kind === "custom",
        identity_state: e.session_value ? "native" : engine.identityPending(e.id) ? "pending"
          : store.continuation(continuationKey(e))?.manual_required || e.agent_kind === "custom"
            || store.continuation(continuationKey(e))?.confirmed_session ? info.terminal_state === "live" ? "manual" : "unknown" : "unknown",
        identity_source: store.continuation(`identity:${e.id}`)?.identity_source ?? (e.agent_kind === "custom" ? "manual" : null),
        identity_check: store.continuation(`identity:${e.id}`)?.identity_check ?? null,
        terminal_id: e.terminal_id, terminal_state: info.terminal_state, can_resume: info.can_resume, resume_reason: info.resume_reason, resume_mode: info.resume_mode,
        requires_action: info.requires_action === true,
        can_rename: info.terminal_state === "live" && !!(liveAgent?.agent ?? liveAgent?.display_agent),
        can_confirm_session: info.can_confirm_session === true,
        can_abandon_restore: info.can_abandon_restore === true,
        restore_kind: info.restore_kind,
        restore_pending: info.restore_pending === true,
        restore_unavailable: info.restore_unavailable === true,
        needs_start_confirmation: engine.canCancelStartup(e.id) || (["starting", "failed"].includes(e.state) && liveAgent?.agent_status === "blocked" && !e.sent_at),
        can_cancel_start: engine.canCancelStartup(e.id),
        can_auto_resume: false, // compatibility for older pages; process launches always require a click
        can_follow_up: info.terminal_state === "live" && (store.continuation(continuationKey(e))?.manual_required || e.agent_kind === "custom" || !!(liveAgent?.agent ?? liveAgent?.display_agent)),
        can_retry: !store.retryRound(original.id) && ["failed", "uncertain", "cancelled", "lost", "interrupted"].includes(e.state) && (info.terminal_state === "live" || (["not_started", "shell"].includes(info.terminal_state) && e.target_kind === "new")),
        retry_round_number: store.retryRound(original.id)?.number ?? null,
        web_link: e.pane_id ? webLinkQuery({ machineId: e.machine_id, workspaceId: e.workspace_id, workspaceLabel: e.workspace_label, paneId: e.pane_id }) : null,
      }; }),
    })),
  };
}

/**
 * Agents the form can choose, per enabled machine, and the folders new agents could start in:
 * where agents run now, most agents first. Only those: a folder used once is not offered for good.
 */
export function agentsSnapshot(_store: Store, engine: Engine) {
  const home = process.env.HOME ?? "";
  return engine.machines.filter((m) => m.enabled).map((m: Machine) => {
    const view = engine.view(m.id);
    const agents = view?.agents ?? [];
    const running = new Map<string, number>();
    for (const a of agents) {
      const cwd = a.foreground_cwd ?? a.cwd;
      if (cwd) running.set(cwd, (running.get(cwd) ?? 0) + 1);
    }
    const folders = [...running.entries()].sort((a, b) => b[1] - a[1]).map(([path, count]) => ({
      path,
      display: m.id === "local" && home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path,
      name: path.replace(/\/+$/, "").split("/").pop() || path,
      agents: count,
    }));
    return {
      machine: { id: m.id, label: m.label },
      loading: !view || view.at === 0,
      error: view?.error ?? null,
      folders,
      terminals: (view?.panes ?? []).map(p => ({ ...p, bound: !!_store.continuation(manualBindingKey(m.id, p.terminal_id)) && manualValid(m.id, _store.continuation(manualBindingKey(m.id, p.terminal_id))!) })),
      agents: agents.map((a) => ({
        pane_id: a.pane_id, terminal_id: a.terminal_id, kind: a.agent ?? a.display_agent ?? "agent", name: a.name ?? null, status: a.agent_status, ready: READY.includes(a.agent_status),
        session_kind: a.agent_session?.kind ?? null, session_value: a.agent_session?.value ?? null,
        workspace_id: a.workspace_id, workspace: view?.workspaces.find((w) => w.workspace_id === a.workspace_id)?.label ?? a.workspace_id, cwd: a.foreground_cwd ?? a.cwd ?? null, title: a.terminal_title_stripped ?? null,
      })),
    };
  });
}

interface NewBroadcastBody {
  title?: unknown;
  prompt?: unknown;
  targets?: { machine?: unknown; pane?: unknown; terminal_id?: unknown; agent_kind?: unknown; session_kind?: unknown; session_value?: unknown; manual?: unknown }[];
  new?: { machine?: unknown; kind?: unknown; cwd?: unknown; count?: unknown }[];
}

/** Turns the form's answer into executions, checked against what the machines have now. */
export function executionsFrom(body: NewBroadcastBody, engine: Engine): NewExecution[] {
  const executions: NewExecution[] = [];
  for (const target of body.targets ?? []) {
    const machine = engine.machine(String(target.machine ?? ""));
    if (!machine) throw new Error(`没有这台机器：${String(target.machine)}`);
    if (target.manual === true) {
      const pane = engine.view(machine.id)?.panes.find(p => p.pane_id === target.pane && p.terminal_id === target.terminal_id);
      const key = manualBindingKey(machine.id, String(target.terminal_id));
      const binding = engine.store.continuation(key);
      if (!pane || !binding || !manualValid(machine.id, binding)) throw new Error("请先明确确认自定义 agent 的终端，进程变化后需重新绑定");
      executions.push({ machine_id: machine.id, machine_label: machine.label, target_kind: "existing", agent_kind: "custom", agent_name: "自定义 agent",
        ...pane, cwd: pane.cwd, continuation_source: key, workspace_label: binding.workspace_label });
      continue;
    }
    const agent = engine.view(machine.id)?.agents.find((a) => a.pane_id === target.pane);
    if (!agent) throw new Error(`${machine.label} 上已经没有 ${String(target.pane)} 这个 agent`);
    if (typeof target.terminal_id !== "string" || target.terminal_id !== agent.terminal_id
      || (target.agent_kind !== undefined && target.agent_kind !== (agent.agent ?? agent.display_agent ?? "agent"))
      || (target.session_value != null && (target.session_kind !== agent.agent_session?.kind || target.session_value !== agent.agent_session?.value))) {
      throw new Error("所选 agent 或会话已变化，请重新勾选后发送");
    }
    executions.push({
      machine_id: machine.id, machine_label: machine.label, target_kind: "existing", agent_kind: agent.agent ?? agent.display_agent ?? "agent", agent_name: agent.name ?? null,
      cwd: agent.foreground_cwd ?? agent.cwd ?? null, pane_id: agent.pane_id, terminal_id: agent.terminal_id, workspace_id: agent.workspace_id, tab_id: agent.tab_id,
      session_kind: agent.agent_session?.kind ?? null, session_value: agent.agent_session?.value ?? null,
      workspace_label: engine.view(machine.id)?.workspaces.find((w) => w.workspace_id === agent.workspace_id)?.label ?? null,
    });
  }
  let slot = 0;
  for (const spec of body.new ?? []) {
    const machine = engine.machine(String(spec.machine ?? ""));
    if (!machine || !machine.enabled) throw new Error(`没有可用的机器：${String(spec.machine)}`);
    const kind = String(spec.kind ?? "");
    if (!AGENT_KINDS.includes(kind)) throw new Error(`不支持的 agent 类型：${kind}`);
    const cwd = String(spec.cwd ?? "").trim();
    const problem = validCwd(machine.id, cwd);
    if (problem) throw new Error(problem);
    const count = Math.max(1, Math.min(20, Math.floor(Number(spec.count ?? 1)) || 1));
    if (machine.id === LOCAL && !isDir(resolveCwd(LOCAL, cwd))) throw new Error(`本机没有这个目录：${cwd}`);
    for (let n = 0; n < count; n += 1) {
      slot += 1;
      executions.push({ machine_id: machine.id, machine_label: machine.label, target_kind: "new", agent_kind: kind, cwd, slot });
    }
  }
  return executions;
}

/**
 * What an agent has shown lately: its history and the screen below it, not the screen alone. A
 * TUI like Claude Code clears the screen when its terminal is resized and leaves the conversation
 * in the history above, so the screen by itself can be an empty box. Unwrapped lines, so the page
 * wraps them to its own width. A Herdr that cannot read history with styles gives the screen.
 */
/** The keys the page may press in an agent's pane: what Herdr's send-keys takes. */
const KEYS = new Set(["enter", "esc", "tab", "shift+tab", "up", "down", "left", "right", "backspace", "space", "ctrl+c"]);

async function screenOf(e: Execution): Promise<string> {
  try {
    return await agentRead(e.machine_id, e.pane_id!, SCREEN_LINES, "recent-unwrapped", "ansi");
  } catch (error) {
    if (/not found/i.test(error instanceof Error ? error.message : "")) throw error;
    return agentRead(e.machine_id, e.pane_id!, 0, "visible", "ansi");
  }
}

export function startWebServer(store: Store, options: WebOptions = webOptions(), timing?: ConstructorParameters<typeof Engine>[2], updates?: Partial<UpdaterOptions> | UpdateController, environmentRunner?: EnvironmentRunner) {
  const engine = new Engine(store, () => {}, timing);
  if (options.paused) engine.pause();
  try {
    const web = serve(store, engine, options, updates, environmentRunner);
    engine.start();
    return web;
  } catch (error) {
    // the port is someone else's: leave no polling engine behind, it would outlive the store
    engine.stop();
    throw error;
  }
}

function serve(store: Store, engine: Engine, options: WebOptions, updates: Partial<UpdaterOptions> | UpdateController = {}, environmentRunner?: EnvironmentRunner) {
  const page = readFileSync(join(import.meta.dir, "page.html"), "utf8");
  const script = readFileSync(join(import.meta.dir, "page.js"), "utf8");
  const icon = readFileSync(join(import.meta.dir, "icon.svg"), "utf8");
  // What this server hands the browser: a page loaded from another server's files reloads itself.
  // The files, not a commit: a restart on uncommitted changes serves new files under the same commit.
  const instance = options.runtime?.bootId ?? randomUUID();
  let accepting = !options.paused;
  let requests = 0;
  const build = createHash("sha256").update(page).update(script).update(readFileSync(join(import.meta.dir, "terminal.js"))).digest("hex").slice(0, 16);
  const assets = new Map(terminalAssets().map((asset) => [`/vendor/${asset.name}`, asset]));
  assets.set("/terminal.js", { name: "terminal.js", path: join(import.meta.dir, "terminal.js"), type: "text/javascript" });
  const terminals = new Set<TerminalBridge>();
  const streams = new Set<ReadableStreamDefaultController<string>>();
  const unwatch = new Map<string, () => void>();
  let lastPushed = "";
  let webUi: WebUiStatus = { installed: false, running: false };
  const updater: UpdateController = "status" in updates ? updates : new Updater({ publish: () => push(), ...updates });
  const environments = new AgentEnvironments(`${store.path}.agent-environment.json`, () => push(), environmentRunner);
  const payload = () => JSON.stringify({ app: "herdr-broadcast", state: snapshot(store, engine), agents: agentsSnapshot(store, engine), webUi,
    update: updater.status, build, environments: [...environments.snapshots.values()], environmentOperations: environments.list() });
  const checkWebUi = async () => {
    webUi = await detectWebUi();
    push();
  };

  /** while a page is open, keep every enabled machine's agents fresh */
  const syncWatches = () => {
    const wanted = streams.size > 0 ? new Set(engine.machines.filter((m) => m.enabled).map((m) => m.id)) : new Set<string>();
    for (const [id, stop] of unwatch) if (!wanted.has(id)) {
      stop();
      unwatch.delete(id);
    }
    for (const id of wanted) if (!unwatch.has(id)) unwatch.set(id, engine.watch(id));
  };

  const push = () => {
    syncWatches();
    if (streams.size === 0) return;
    const body = payload();
    if (body === lastPushed) return;
    lastPushed = body;
    for (const stream of streams) {
      try {
        stream.enqueue(`data: ${body}\n\n`);
      } catch {
        streams.delete(stream);
      }
    }
  };
  const conversations = new Conversations(store, engine, push);

  const allowedHost = (host: string | null): boolean => {
    if (!host) return false;
    const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    return ["localhost", "127.0.0.1", "::1", ...options.hosts].includes(name);
  };

  const execution = (id: string): Execution => {
    const e = store.execution(Number(id));
    if (!e) throw Object.assign(new Error("没有这个执行"), { status: 404 });
    if (!e.pane_id) throw Object.assign(new Error("这个执行还没有 pane"), { status: 409 });
    return e;
  };

  const server = Bun.serve<TerminalSocketData>({
    hostname: options.host,
    port: options.port,
    idleTimeout: 0,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      if (!allowedHost(request.headers.get("host"))) return fail(421, "bad_host", "Host 不被允许；在 web_hosts 里加上它");
      // the token, once in the address, becomes a cookie and leaves the address
      if (options.token) {
        const given = url.searchParams.get("token") ?? cookie(request, "broadcast_token") ?? request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (!sameSecret(given, options.token)) return fail(401, "token_required", "需要 token：打开 /?token=…");
        if (url.searchParams.has("token")) {
          url.searchParams.delete("token");
          return new Response(null, { status: 303, headers: { location: `${url.pathname}${url.search}`, "set-cookie": `broadcast_token=${encodeURIComponent(options.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` } });
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        const site = request.headers.get("sec-fetch-site");
        if (site ? site !== "same-origin" : !sameOrigin(request.headers.get("origin"), request.headers.get("host"))) return fail(403, "cross_site", "只接受本页面发出的请求");
      }
      const control = ["/api/update/check", "/api/update/install", "/api/update/apply", "/api/web/restart"].includes(url.pathname);
      if (!accepting && !control && (request.method !== "GET" || url.pathname.endsWith("/terminal"))) return fail(503, "service_restarting", "服务正在重启，请稍后重试；未提交的内容仍保留");
      requests++;
      try {
        const terminal = /^\/api\/executions\/(\d+)\/terminal$/.exec(url.pathname);
        if (terminal) {
          if (request.method !== "GET") return fail(405, "method", "GET only");
          // A WebSocket GET can write to a terminal. Check Origin even when Sec-Fetch-Site exists.
          if (!sameOrigin(request.headers.get("origin"), request.headers.get("host"))) return fail(403, "cross_site", "只接受本页面的终端连接");
          const target = await conversations.target(execution(terminal[1]!));
          if (!target) return fail(409, "terminal_closed", "原终端已关闭或会话已改变，请使用恢复对话");
          const e = target.execution;
          const cols = Number(url.searchParams.get("cols")), rows = Number(url.searchParams.get("rows"));
          if (!terminalGeometry(cols, rows)) return fail(400, "geometry", "终端尺寸无效");
          const takeover = url.searchParams.get("takeover") === "1";
          if (bunServer.upgrade(request, { data: { execution: e, cols, rows, takeover } })) return;
          return fail(400, "upgrade", "需要 WebSocket 连接");
        }
        return await route(request, url, localRequest(request, bunServer.requestIP(request)?.address ?? null));
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return fail(status, "failed", error instanceof Error ? error.message : String(error));
      } finally { requests--; }
    },
    websocket: {
      maxPayloadLength: 128 * 1024,
      backpressureLimit: 8 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 60,
      sendPings: true,
      open(socket) {
        if (!accepting) { socket.close(1012, "Service restarting"); return; }
        const bridge = new TerminalBridge(socket);
        socket.data.bridge = bridge;
        terminals.add(bridge);
        void bridge.done.finally(() => terminals.delete(bridge));
      },
      message(socket, message) {
        if (!accepting) { socket.close(1012, "Service restarting"); return; }
        socket.data.bridge?.message(message);
      },
      close(socket) { socket.data.bridge?.stop(); },
    },
  });

  /**
   * A request from a browser on this computer itself: loopback, addressed as localhost, and not
   * passed on by a proxy (Tailscale serve, an SSH tunnel's far end). Only such a request may
   * write to ~/.ssh or save a machine.
   */
  function localRequest(request: Request, address: string | null): boolean {
    if (!address || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) return false;
    if (request.headers.has("x-forwarded-for") || request.headers.has("forwarded") || request.headers.has("x-forwarded-host")) return false;
    const name = (request.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    return ["localhost", "127.0.0.1", "::1"].includes(name);
  }

  /** machine states from `herdr machine status`, read at most this often: it connects to each */
  let health: { at: number; byId: Record<string, MachineHealth>; error: string | null } = { at: 0, byId: {}, error: null };
  const readHealth = async (fresh: boolean) => {
    if (!fresh && Date.now() - health.at < HEALTH_TTL_MS) return health;
    try {
      health = { at: Date.now(), byId: parseMachineStatus(await machineStatus(), engine.machines), error: null };
    } catch (error) {
      health = { at: Date.now(), byId: {}, error: error instanceof Error ? error.message : String(error) };
    }
    return health;
  };

  /** after a machine changed: the list read again, and every page told */
  const machinesChanged = async () => {
    await engine.refreshMachines();
    health.at = 0;
    push();
  };

  /** `herdr machine add` in a terminal of its own, its questions answered on the page */
  const addJobs = new AddJobs(async (job) => {
    if (job.state === "done") await machinesChanged();
  }, dirname(store.path), localHerdrVersion);

  // Only start background work after the HTTP port has been bound successfully.
  void checkWebUi();
  void environments.reconcile();
  const webUiTimer = setInterval(() => void checkWebUi(), WEB_UI_CHECK_MS);
  const pusher = setInterval(push, PUSH_EVERY_MS);
  const beat = setInterval(() => store.heartbeat(WEB_LOCK), HEARTBEAT_MS);
  if (options.checkUpdates) updater.start();

  async function route(request: Request, url: URL, local: boolean): Promise<Response> {
    const path = url.pathname;
    if (path === "/api/health") return json({ app: "herdr-broadcast", instance, ...options.runtime, dispatching: accepting, schema: store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version });
    const asset = assets.get(path);
    if (asset) return new Response(Bun.file(asset.path), { headers: { "content-type": asset.type, "cache-control": "no-store" } });
    if (path === "/" || path === "/index.html") {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP } });
    }
    if (path === "/page.js") {
      return new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP } });
    }
    if (path === "/icon.svg" || path === "/favicon.ico") {
      return new Response(icon, { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" } });
    }
    if (path === "/api/config") {
      await updater.describe().catch(() => {});
      const config = loadConfig();
      return json({ webUiUrl: config.webUrl, kinds: DEFAULT_AGENT_KINDS, capabilities: AGENTS, local, instance, update: updater.status, pluginId: process.env.HERDR_PLUGIN_ID || "herdr-broadcast" });
    }
    if (path === "/api/web/restart") {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      if (!local) return fail(403, "local_only", "重启服务只能在服务所在电脑的浏览器里操作");
      const update = await updater.restart();
      return json({ update, instance, operationId: update.operation_id }, 202);
    }
    if (path === "/api/update/check" || path === "/api/update/install" || path === "/api/update/apply") {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      // replacing the plugin's files and restarting it: from this computer's own browser only
      if (!local) return fail(403, "local_only", "更新插件只能在这台电脑本机的浏览器里操作");
      if (path === "/api/update/check") return json({ update: await updater.check() });
      const update = path === "/api/update/apply" ? await updater.applyLocal() : await updater.install();
      return json({ update, instance, operationId: update.operation_id }, 202);
    }
    if (path === "/api/machines/health") {
      const h = await readHealth(url.searchParams.has("fresh"));
      return json({ health: h.byId, error: h.error, at: h.at });
    }
    if (path === "/api/machines/web-ui") {
      // where herdr-web-ui keeps its keys: for the page that adds machines, on this computer
      if (!local) return fail(403, "local_only", "添加机器只能在这台电脑本机的浏览器里操作");
      return json(await webUiMachines(await machineList()));
    }
    let match = /^\/api\/machines\/([^/]+)\/(environment|prepare-agents|manual-binding)$/.exec(path);
    if (match) {
      const machine = engine.machine(decodeURIComponent(match[1]!));
      if (!machine?.enabled) return fail(404, "machine_unavailable", "机器不存在或已停用");
      if (match[2] === "environment") {
        if (request.method !== "GET") return fail(405, "method", "GET only");
        return json(await environments.check(machine.id));
      }
      if (request.method !== "POST") return fail(405, "method", "POST only");
      if (match[2] === "prepare-agents") {
        if (!local) return fail(403, "local_only", "准备集成只能从本机页面操作");
        const body = await request.json() as { integrations?: unknown };
        const operation = environments.start(machine.id, body.integrations, machine.target ?? LOCAL);
        return json({ operationId: operation.id, operation }, 202);
      }
      const body = await request.json() as { pane?: unknown; terminal_id?: unknown };
      await engine.refresh(machine.id);
      const pane = engine.view(machine.id)?.panes.find(p => p.pane_id === body.pane && p.terminal_id === body.terminal_id);
      if (!pane) throw new Error("所选终端已变化");
      await confirmManual(store, machine.id, pane, manualBindingKey(machine.id, pane.terminal_id), "自定义 agent");
      push(); return json({ ok: true, terminal_id: pane.terminal_id });
    }
    match = /^\/api\/environment-operations\/([^/]+)$/.exec(path);
    if (match) {
      if (!["GET", "DELETE"].includes(request.method)) return fail(405, "method", "GET or DELETE only");
      if (request.method === "DELETE" && !local) return fail(403, "local_only", "取消准备只能从本机页面操作");
      const operation = request.method === "DELETE" ? environments.cancel(match[1]!) : environments.get(match[1]!);
      return operation ? json({ operation }) : fail(404, "not_found", "没有这个准备操作");
    }
    match = /^\/api\/machines\/([^/]+)\/focus$/.exec(path);
    if (match) {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      // switches what this computer's Herdr shows: from its own browser only
      if (!local) return fail(403, "local_only", "只能在这台电脑本机的浏览器里切换 Herdr");
      const machine = engine.machine(decodeURIComponent(match[1]!));
      if (!machine) throw Object.assign(new Error("没有这台机器"), { status: 404 });
      await engine.refresh(machine.id);
      const view = engine.view(machine.id);
      const why = machineUnavailable(machine, view);
      if (why) throw new Error(why);
      const workspace = machineWorkspace(view)!;
      await workspaceFocus(machine.id, workspace.workspace_id);
      return json({ ok: true, message: machine.id === LOCAL ? `已在 Herdr 中切到「${workspace.label}」`
        : `已在 ${machine.label} 上切到「${workspace.label}」；在 Herdr 侧栏切到这台机器即可看到` });
    }
    match = /^\/api\/machines\/([^/]+)(?:\/(rename|enable|disable))?$/.exec(path);
    if (match && !["add", "web-ui"].includes(match[1]!) && (request.method === "POST" || request.method === "DELETE")) {
      const machine = engine.machine(decodeURIComponent(match[1]!));
      if (!machine || machine.id === LOCAL) throw Object.assign(new Error("没有这台机器"), { status: 404 });
      if (request.method === "DELETE") await machineRemove(machine.id);
      else if (match[2] === "rename") {
        const label = String(((await request.json()) as { label?: unknown }).label ?? "").trim();
        if (!label) throw new Error("名称不能为空");
        await machineRename(machine.id, label.slice(0, 60));
      } else if (match[2] === "enable" || match[2] === "disable") {
        await machineSetEnabled(machine.id, match[2] === "enable");
        // read it again now, so the page does not show an old failure for a machine just enabled
        if (match[2] === "enable") await engine.refresh(machine.id);
      } else throw Object.assign(new Error("not found"), { status: 404 });
      await machinesChanged();
      return json({ ok: true });
    }
    match = /^\/api\/machines\/add\/(add-\d+)(?:\/(answer))?$/.exec(path);
    if (match) {
      if (!local) return fail(403, "local_only", "添加机器只能在这台电脑本机的浏览器里操作");
      const id = match[1]!;
      if (request.method === "GET") {
        const job = addJobs.get(id);
        return job ? json({ job }) : fail(404, "not_found", "没有这个添加任务");
      }
      if (request.method === "DELETE") return json({ job: addJobs.cancel(id) });
      if (request.method === "POST" && match[2] === "answer") {
        const { yes } = (await request.json()) as { yes?: unknown };
        return json({ job: addJobs.answer(id, yes === true) });
      }
      return fail(405, "method", "not allowed");
    }
    if (path.startsWith("/api/ssh/") || path === "/api/machines/add") {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      // writing to ~/.ssh and saving a machine: only from this computer's own browser
      if (!local) return fail(403, "local_only", "添加机器只能在这台电脑本机的浏览器里操作");
      const body = (await request.json()) as { target?: unknown; label?: unknown; fingerprints?: unknown; key?: unknown; name?: unknown; session?: unknown; install?: unknown; system?: unknown };
      if (path === "/api/ssh/keygen") return json({ key: await generateKey() });
      if (path === "/api/ssh/key-fix") return json({ key: await tightenKey(String(body.key ?? "")) });
      const target = parseTarget(String(body.target ?? ""));
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : null;
      if (path === "/api/ssh/check") return json(await checkTarget(target));
      if (path === "/api/ssh/config-entry") {
        // a server that wants its own key: the Host entry it needs, shown before anything is written
        const name = typeof body.name === "string" && body.name.trim() ? body.name : suggestEntryName(target, label);
        return json(await configEntry(target, String(body.key ?? ""), name));
      }
      if (path === "/api/ssh/config-write") return json(await writeConfigEntry(target, String(body.key ?? ""), String(body.name ?? "")));
      if (path === "/api/ssh/trust") {
        await trustHostKey(target, Array.isArray(body.fingerprints) ? body.fingerprints.map(String) : []);
        return json({ ok: true, login: await verifyLogin(target) });
      }
      if (path === "/api/ssh/verify") return json({ login: await verifyLogin(target), key: await localKey() });
      if (path === "/api/machines/add") {
        // installing or updating Herdr there is approved with the request: the page said what it does
        return json({ job: addJobs.start(target, { label, session: parseSession(body.session), install: body.install === true, system: typeof body.system === "string" ? body.system : null }) });
      }
      if (path === "/api/ssh/terminal") {
        const session = parseSession(body.session);
        const opened = await openAddTerminal(target, label, session);
        return json({
          ...opened,
          command: addCommand(target, label, session),
          web_link: opened.paneId ? webLinkQuery({ machineId: LOCAL, workspaceId: opened.workspaceId ?? "", workspaceLabel: opened.workspaceLabel, paneId: opened.paneId }) : null,
        });
      }
      return fail(404, "not_found", "not found");
    }
    if (path === "/api/state") return new Response(payload(), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    if (path === "/api/dirs") {
      // folder completion for the form; only this machine's folders are read
      if ((url.searchParams.get("machine") ?? LOCAL) !== LOCAL) return json({ suggestions: [], target: null });
      return json(listDirs(url.searchParams.get("q") ?? ""));
    }
    if (path === "/api/events") {
      let controller: ReadableStreamDefaultController<string>;
      const stream = new ReadableStream<string>({
        start(c) {
          controller = c;
          streams.add(c);
          lastPushed = "";
          c.enqueue(`data: ${payload()}\n\n`);
          syncWatches();
        },
        cancel() {
          streams.delete(controller);
          syncWatches();
        },
      });
      request.signal.addEventListener("abort", () => {
        streams.delete(controller);
        syncWatches();
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
    }
    match = /^\/api\/executions\/(\d+)\/conversation-options$/.exec(path);
    if (match) {
      if (request.method !== "GET") return fail(405, "method", "GET only");
      return json({ options: await conversations.options(execution(match[1]!)) });
    }
    match = /^\/api\/executions\/(\d+)\/select-conversation$/.exec(path);
    if (match) {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      const body = await request.json() as { terminal_id?: unknown };
      await conversations.selectTarget(execution(match[1]!), body.terminal_id);
      return json({ ok: true });
    }
    match = /^\/api\/executions\/(\d+)\/confirm-session$/.exec(path);
    if (match) {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      const body = await request.json() as { terminal_id?: unknown };
      await conversations.confirmSession(execution(match[1]!), body?.terminal_id);
      push();
      return json({ ok: true });
    }
    match = /^\/api\/broadcasts\/(\d+)\/follow-up$/.exec(path);
    if (match) {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      const parentId = Number(match[1]);
      if (!store.getBroadcast(parentId)) throw new Error("原广播记录不存在");
      const body = await request.json() as { prompt?: unknown; targets?: { execution_id?: unknown; terminal_id?: unknown }[] };
      const prompt = typeof body.prompt === "string" ? body.prompt.trimEnd() : "";
      if (!prompt.trim()) throw new Error("请输入要继续广播的内容");
      if (!Array.isArray(body.targets) || !body.targets.length || body.targets.length > 100) throw new Error("请选择 1 到 100 个 agent");
      const seen = new Set<string>();
      const executions: NewExecution[] = [];
      // Validate the whole selection before creating a task or sending any input.
      for (const selected of body.targets) {
        if (!Number.isSafeInteger(selected?.execution_id)) throw new Error("agent 选择无效");
        const original = store.execution(Number(selected.execution_id));
        if (!original || original.broadcast_id !== parentId) throw new Error("所选 agent 不属于这个广播");
        const target = await conversations.target(original);
        if (!target || target.mode !== "reconnect") throw new Error("所选 agent 已关闭或仍在等待恢复，请处理后再发送");
        const e = target.execution;
        if (!e.agent_kind || !e.terminal_id || selected.terminal_id !== e.terminal_id) throw new Error("所选终端已变化，请重新勾选后发送");
        const key = JSON.stringify([e.machine_id, e.terminal_id]);
        if (seen.has(key)) continue;
        seen.add(key);
        executions.push({ ...e, target_kind: "existing", continuation_source: continuationKey(original), parent_execution_id: original.id });
      }
      engine.assertAccepting();
      const round = store.createRound(parentId, prompt, executions);
      engine.submit(round.id);
      push();
      return json({ id: parentId, round_id: round.id, round_number: round.number, executions: executions.length });
    }
    if (path === "/api/broadcasts" && request.method === "POST") {
      const body = (await request.json()) as NewBroadcastBody;
      const prompt = typeof body.prompt === "string" ? body.prompt.replace(/\s+$/, "") : "";
      if (!prompt.trim()) throw new Error("prompt 不能为空");
      // the chosen agents are checked against a fresh read of their machines
      const named = new Set((body.targets ?? []).map((t) => String(t.machine ?? "")));
      await Promise.all([...named].filter((id) => engine.machine(id)).map((id) => engine.refresh(id)));
      for (const target of body.targets ?? []) if (target.manual === true) {
        const binding = store.continuation(manualBindingKey(String(target.machine), String(target.terminal_id)));
        if (!binding || !await refreshManual(String(target.machine), binding)) throw new Error("人工绑定失效，请重新确认终端");
      }
      const executions = executionsFrom(body, engine);
      if (executions.length === 0) throw new Error("至少选择一个 agent，或添加一个新 agent");
      const firstLine = prompt.split("\n").find((l) => l.trim())!.trim();
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : Array.from(firstLine).slice(0, 60).join("");
      engine.assertAccepting();
      const id = store.createBroadcast({ title, prompt, executions });
      engine.submit(store.rounds(id)[0]!.id);
      push();
      return json({ id, executions: executions.length });
    }
    match = /^\/api\/broadcasts\/(\d+)$/.exec(path);
    if (match && request.method === "DELETE") {
      if (store.executions(Number(match[1])).some(e => ACTIVE_STATES.includes(e.state))) return fail(409, "sending", "正在发送，请等本次发送操作结束后再删除记录");
      store.deleteBroadcast(Number(match[1]));
      push();
      return json({ ok: true });
    }
    match = /^\/api\/executions\/(\d+)\/input$/.exec(path);
    if (match) {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      const target = await conversations.target(execution(match[1]!));
      if (!target) throw new Error("原终端已关闭或会话已改变，请使用恢复对话");
      const e = target.execution;
      if (!e.pane_id) throw new Error("这个 agent 还没启动");
      const body = (await request.json()) as { text?: unknown; keys?: unknown; submit?: unknown; raw?: unknown };
      if (typeof body.raw === "string" && body.raw.length) {
        // keystrokes from the page's terminal, as a terminal would send them
        if (body.raw.length > 20_000) throw new Error("一次输入太长了");
        await paneSendText(e.machine_id, e.pane_id, body.raw);
        return json({ ok: true });
      }
      if (typeof body.text === "string" && body.text.length) {
        const text = body.text.replace(/\r\n?/g, "\n");
        if (text.length > 20_000) throw new Error("一次输入太长了");
        // a message for the agent goes in as a prompt does; bare text (an answer to a menu) is typed
        if (body.submit === true) {
          try {
            await submitPrompt(e.machine_id, e.pane_id, text);
          } catch (error) {
            // an agent that is busy or asking takes it as typed, as it would from a keyboard
            if (!(error instanceof HerdrError) || error.code === "timeout") throw error;
            await paneSendText(e.machine_id, e.pane_id, text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text);
            await Bun.sleep(150);
            await paneSendKeys(e.machine_id, e.pane_id, ["enter"]);
          }
        } else await paneSendText(e.machine_id, e.pane_id, text);
      }
      if (Array.isArray(body.keys) && body.keys.length) {
        const keys = body.keys.map(String);
        const bad = keys.find((k) => !KEYS.has(k));
        if (bad) throw new Error(`不支持的按键：${bad}`);
        if (keys.length > 20) throw new Error("一次按键太多了");
        await paneSendKeys(e.machine_id, e.pane_id, keys);
      }
      return json({ ok: true });
    }
    match = /^\/api\/executions\/(\d+)\/rename$/.exec(path);
    if (match) {
      if (request.method !== "POST") return fail(405, "method", "POST only");
      const body = await request.json() as { name?: unknown; terminal_id?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error("名称须以小写字母开头，只能包含小写字母、数字、-、_，最多 32 个字符");
      const original = execution(match[1]!);
      const target = await conversations.target(original);
      if (!target || target.mode !== "reconnect") throw new Error("原 agent 已关闭或会话尚未确认，请先恢复对话再改名");
      const e = target.execution;
      if (typeof body.terminal_id !== "string" || body.terminal_id !== e.terminal_id) return fail(409, "terminal_changed", "终端已变化，请重新打开改名框");
      try {
        await agentRename(e.machine_id, e.pane_id!, name);
      } catch (error) {
        if (error instanceof HerdrError && error.code === "agent_name_taken") throw new Error("这个名称已被其他 agent 使用，请换一个");
        throw error;
      }
      store.rememberAgentName(original, name);
      await engine.refresh(e.machine_id);
      push();
      return json({ ok: true, name });
    }
    match = /^\/api\/executions\/(\d+)\/(screen|focus|cancel|retry|continue|recover|interrupt|not-delivered|abandon-restore)$/.exec(path);
    if (match) {
      const [, id, what] = match;
      if (what === "screen") {
        const target = await conversations.target(execution(id!));
        if (!target) throw new Error("原终端已关闭或会话已改变，请使用恢复对话");
        const e = target.execution;
        // with its colors, as the agent drew it; only the styles survive, never a cursor move
        return json({ text: sanitizeKeepStyle(await screenOf(e)), ansi: true, at: Date.now() });
      }
      if (request.method !== "POST") return fail(405, "method", "POST only");
      if (what === "abandon-restore") {
        const body = await request.json() as { terminal_id?: unknown };
        await conversations.abandon(execution(id!), body.terminal_id);
        push();
        return json({ ok: true });
      }
      if (what === "interrupt") {
        const original = execution(id!);
        const body = await request.json() as { terminal_id?: unknown };
        const target = await conversations.target(original);
        if (!target || target.mode !== "reconnect") throw new Error("请先确认原会话连接，未发送中断请求");
        await engine.interrupt(target.execution, body.terminal_id);
        push();
        return json({ ok: true, message: "已向当前 agent 发送 Ctrl+C，请查看终端确认。" });
      }
      if (what === "not-delivered") {
        const e = execution(id!);
        const body = await request.json() as { terminal_id?: unknown; confirmed?: unknown };
        if (body.confirmed !== true || body.terminal_id !== e.terminal_id) throw new Error("请先检查原对话，明确确认本轮任务未送达");
        const target = await conversations.target(e);
        if (!target || target.mode !== "reconnect" || target.execution.terminal_id !== e.terminal_id) throw new Error("终端已变化，请重新检查");
        const agent = await agentGet(e.machine_id, target.execution.pane_id!);
        if (resumeIdentityIssue(store, e, agent)) throw new Error("会话身份已变化，请重新检查");
        if (!["sent", "uncertain"].includes(e.state) || !store.claim(e.id, [e.state], "failed")) throw new Error("发送状态已变化，不能标记未送达");
        store.update(e.id, { error: "用户检查原对话后确认本轮任务未送达，可再次发送。", note: null });
        push();
        return json({ ok: true });
      }
      if (what === "continue" || what === "recover") {
        const text = await request.text();
        const body = text ? JSON.parse(text) : {};
        const original = execution(id!);
        let result;
        try { result = await conversations.continue(original, what === "recover" || body?.choose_session === true, what === "recover"); }
        catch (error) {
          if (error instanceof RestoreUnavailableError) return json({ ok: true, mode: "unavailable" });
          throw error;
        }
        push();
        return json({ ok: true, ...result });
      }
      if (what === "focus") {
        // switches what this computer's Herdr shows: from its own browser only
        if (!local) return fail(403, "local_only", "只能在这台电脑本机的浏览器里切换 Herdr");
        // the page only watches; an agent is used where it runs, here brought to the front in Herdr
        const target = await conversations.target(execution(id!));
        if (!target) throw new Error("原终端已关闭，请先恢复对话");
        return json({ ok: true, message: await engine.focus(target.execution) });
      }
      const e = store.execution(Number(id));
      if (!e) return fail(404, "not_found", "没有这个执行");
      if (what === "cancel") {
        if (engine.cancelStartup(e.id)) { push(); return json({ ok: true }); }
        return fail(410, "no_queue", "广播立即发送，不再提供取消排队；已发送的消息请在 agent 中处理");
      }
      // Explicit retries append a delivery attempt; they never rewrite the original result.
      const round = await engine.retry(e);
      push();
      return json({ ok: true, round_id: round.id, round_number: round.number });
    }
    return fail(404, "not_found", "not found");
  }

  return {
    server,
    engine,
    updater,
    environments,
    resume() { accepting = true; engine.resume(); },
    async drain(timeoutMs = 120_000): Promise<boolean> {
      accepting = false; engine.pause();
      const closing = [...terminals];
      const terminalDrains = closing.map(terminal => terminal.drain());
      let timer: ReturnType<typeof setTimeout>;
      const settled = (async () => {
        while (requests > 0) await Bun.sleep(10);
        await conversations.settle();
        await Promise.allSettled(terminalDrains);
        await addJobs.settle();
        await environments.settle();
        await engine.settle();
        return true;
      })();
      const ok = await Promise.race([settled, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
      clearTimeout(timer!);
      if (!ok) { accepting = true; engine.resume(); }
      return ok;
    },
    url: `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${server.port}/`,
    /** Stops serving and waits for reads and sends in flight, so the store can close after. */
    async stop() {
      accepting = false;
      clearInterval(pusher);
      clearInterval(beat);
      clearInterval(webUiTimer);
      updater.stop();
      for (const stop of unwatch.values()) stop();
      addJobs.stopAll();
      environments.stop();
      engine.stop();
      const closing = [...terminals];
      for (const terminal of closing) terminal.stop();
      server.stop(true);
      await conversations.settle();
      await addJobs.settle();
      await environments.settle();
      await Promise.allSettled(closing.map((terminal) => terminal.done));
      await engine.settle();
    },
  };
}

/** Whether a web server for this database is running. */
export function webRunning(store: Store): boolean {
  return store.lockHolder(WEB_LOCK, pidAlive, HEARTBEAT_MS * 4) !== null;
}
