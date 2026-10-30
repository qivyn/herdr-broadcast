/**
 * Immediate broadcast delivery and read-only machine snapshots.
 * Only an explicit submission starts work; timers, reconnects and restarts never send history.
 * Agents own their message scheduling. Delivery finishes when terminal submission returns.
 */
import { pidAlive, type Execution, type Store } from "./db.ts";
import { conversationTarget, resumeIdentityIssue, unsentNewExecution } from "./conversation-target.ts";
export { unsentNewExecution } from "./conversation-target.ts";
import {
  agentFocus, agentGet, agentList, agentPrompt, agentStart, agentWaitReady, HerdrError, LOCAL, machineList, paneRead, paneSendKeys, paneSendText, tabCreate, tabFocus, tabRename,
  workspaceCreate, workspaceFocus, workspaceList, paneList, type Created, type MachineProfile,
} from "./herdr.ts";
import type { AgentInfo, PaneInfo, WorkspaceInfo } from "./herdr-types.ts";
import { refreshManual } from "./manual-session.ts";
import { continuationKey } from "./conversation-target.ts";
import { agentLaunchArgs, codexInputBlock } from "./agent-launch.ts";
import { acquireIdentity } from "./identity-acquisition.ts";
import { verifyReportedSession } from "./session-discovery.ts";

export interface Machine {
  /** LOCAL or a saved profile id */
  id: string;
  label: string;
  enabled: boolean;
  target: string | null;
}

export interface MachineView {
  agents: AgentInfo[];
  panes: PaneInfo[];
  workspaces: WorkspaceInfo[];
  /** when the last successful read finished */
  at: number;
  error: string | null;
  loading: boolean;
}

const LOCAL_POLL_MS = 2_000;
const REMOTE_POLL_MS = 4_000;
const MACHINES_REFRESH_MS = 30_000;
export const READY: readonly string[] = ["idle", "done"];

export function localLabel(): string {
  return "本机";
}

/** Herdr agent names: [a-z][a-z0-9_-]{0,31}. */
export function agentNameFor(broadcastId: number, kind: string, slot: number): string {
  const safeKind = kind.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 12) || "agent";
  return `bc${broadcastId}-${safeKind}-${slot}`.slice(0, 32);
}

export function workspaceLabelFor(broadcastId: number, title: string): string {
  const short = title.replace(/\s+/g, " ").trim();
  return Array.from(`📡${broadcastId} ${short}`).slice(0, 36).join("");
}

/** A new agent's tab: its kind and number, and the folder it works in, since a broadcast's tabs share a workspace. */
export function tabLabelFor(kind: string, slot: number, cwd: string): string {
  const folder = cwd.replace(/\/+$/, "").split("/").pop() || cwd;
  return Array.from(`${kind}-${slot} · ${folder}`).slice(0, 40).join("");
}

/** Herdr does not expand ~ in a local --cwd; a remote one is resolved on that machine. */
export function resolveCwd(machineId: string, cwd: string): string {
  if (machineId !== LOCAL) return cwd;
  const home = process.env.HOME ?? "";
  if (cwd === "~") return home;
  if (cwd.startsWith("~/")) return `${home}${cwd.slice(1)}`;
  return cwd;
}

function message(error: unknown): string {
  if (error instanceof HerdrError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sleeps until `ms` or until `signal` aborts, so a watcher leaves as soon as its start is done. */
function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * A shell's own words when the command an agent was started with could not run at all — the
 * machine has no such program, or cannot execute it. Herdr then waits out its whole timeout.
 */
const LAUNCH_FAILED = /command not found|No such file or directory|not recognized as an internal or external command|Permission denied|Exec format error/i;

/** The command could not be started in this pane: `output` is what the shell said. */
export class LaunchFailedError extends Error {
  constructor(message: string, readonly output: string) { super(message); }
}

class StartupSendCancelled extends Error {}

/** The shell's last lines, without the trailing prompt that follows the error. */
export function launchFailureText(output: string): string {
  const lines = output.replace(/\r/g, "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  const at = lines.map((line) => LAUNCH_FAILED.test(line)).lastIndexOf(true);
  const said = at >= 0 ? lines.slice(Math.max(0, at - 1), at + 1) : lines.slice(-2);
  return said.join("\n").trim();
}

/** The gap between a typed prompt and its Enter, so a TUI still taking the paste does not read Enter as a newline. */
const SUBMIT_DELAY_MS = 300;

/**
 * A prompt ending in an `@file` mention leaves the agent's file suggestions open, and the Enter
 * would pick a suggestion instead of sending (herdr-web-ui hit this with Claude Code): a trailing
 * space closes them.
 */
export function shapePrompt(text: string): string {
  return /(?:^|\s)@\S+$/.test(text) ? `${text} ` : text;
}

/**
 * Herdr's agent prompt (paste, then Enter) for the agents it has a manifest for. An agent that
 * reports itself through `pane report-agent` has none, and Herdr refuses it as "not an active
 * named agent"; that one is typed into the pane instead, as herdr-web-ui does.
 */
// Serialize only the terminal write (paste + Enter), never the agent's AI work.
const promptWrites = new Map<string, Promise<AgentInfo | null>>();
export async function submitPrompt(machine: string, pane: string, text: string, beforeWrite?: () => Promise<void>, manual = false): Promise<AgentInfo | null> {
  const key = JSON.stringify([machine, pane]);
  const previous = promptWrites.get(key) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    await beforeWrite?.();
    const shaped = shapePrompt(text);
    if (manual) {
      if (!beforeWrite) throw new Error("人工终端需要验证进程身份");
      try {
        await paneSendText(machine, pane, shaped.includes("\n") ? `\x1b[200~${shaped}\x1b[201~` : shaped);
        await sleep(SUBMIT_DELAY_MS);
        await beforeWrite();
        await paneSendKeys(machine, pane, ["enter"]);
      } catch (error) { throw new Error(message(error)); }
      return null;
    }
    try {
      return await agentPrompt(machine, pane, shaped);
    } catch (error) {
      if (!(error instanceof HerdrError) || (error.code !== "agent_not_ready" && error.code !== "agent_not_found")) throw error;
      const agent = await agentGet(machine, pane).catch(() => null);
      if (!agent || ![...READY, "working"].includes(agent.agent_status)) throw error;
      // Recheck identity before the raw-input fallback as well.
      await beforeWrite?.();
      try {
        await paneSendText(machine, pane, shaped.includes("\n") ? `\x1b[200~${shaped}\x1b[201~` : shaped);
        await sleep(SUBMIT_DELAY_MS);
        await beforeWrite?.();
        await paneSendKeys(machine, pane, ["enter"]);
        return null; // Raw input has no session-bearing delivery response.
      } catch (failure) {
        // After a raw paste begins, even a later "not found" cannot prove no input arrived.
        throw new Error(message(failure));
      }
    }
  });
  promptWrites.set(key, write);
  try { return await write; }
  finally { if (promptWrites.get(key) === write) promptWrites.delete(key); }
}

export class Engine {
  machines: Machine[] = [{ id: LOCAL, label: localLabel(), enabled: true, target: null }];
  machinesError: string | null = null;
  private machinesAt = 0;
  private views = new Map<string, MachineView>();
  private polling = new Map<string, Promise<void>>();
  private lastPoll = new Map<string, number>();
  private watched = new Map<string, number>();
  /** executions this process is starting or sending right now */
  private busy = new Set<number>();
  /** serializes workspace creation per broadcast + machine */
  private groupLocks = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timing: { tickMs: number; localPollMs: number; remotePollMs: number; launchPollMs: number; startupConfirmMs: number; identityWaitMs: number };
  private identityWaits = new Map<number, AbortController>();
  identityPending(id: number): boolean { return this.identityWaits.has(id); }
  private startupWaits = new Map<number, AbortController>();
  /** reads, sends and starts in flight, so a process can wait for them before it lets go of its database */
  private pending = new Set<Promise<unknown>>();
  /** set by stop(): a read that answers afterwards moves nothing along */
  private stopped = false;
  private paused = false;

  constructor(readonly store: Store, private readonly changed: () => void, timing: Partial<Engine["timing"]> = {},
    readonly launchArgs = agentLaunchArgs, private readonly verifyIdentity = verifyReportedSession) {
    this.timing = { tickMs: 500, localPollMs: LOCAL_POLL_MS, remotePollMs: REMOTE_POLL_MS, launchPollMs: 1_000, startupConfirmMs: 300_000, identityWaitMs: 15_000, ...timing };
  }

  private track(work: Promise<unknown>): void {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
  }

  /** Waits until nothing this process started is still in flight. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Executions this process is starting or sending right now: quitting would interrupt them. */
  get busyCount(): number {
    return this.busy.size;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.store.retireLegacyQueue();
    this.store.recoverAbandoned(pidAlive);
    this.track(this.refreshMachines());
    this.timer = setInterval(() => this.track(this.tick()), this.timing.tickMs);
    this.track(this.tick());
  }

  /** Stops polling and startup-confirmation waits. Other in-flight work finishes; await settle() before closing the store. */
  stop(): void {
    this.stopped = true;
    for (const wait of this.identityWaits.values()) wait.abort();
    this.abortStartupWaits();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Refuse new submissions and end startup-confirmation waits; other accepted operations finish normally. */
  pause(): void { this.paused = true; this.abortStartupWaits(); for (const wait of this.identityWaits.values()) wait.abort(); }
  resume(): void { this.paused = false; }
  get dispatching(): boolean { return !this.stopped && !this.paused; }
  assertAccepting(): void {
    if (!this.dispatching) throw Object.assign(new Error("服务正在重启，请稍后重新发送；消息不会排队"), { status: 503 });
  }

  /** Called synchronously after creating this request's history, never from polling/recovery. */
  submit(roundId: number): void {
    this.assertAccepting();
    const round = this.store.getRound(roundId);
    if (!round) throw new Error("广播轮次不存在");
    for (const e of this.store.executions(round.broadcast_id)) {
      if (e.round_id !== roundId || e.state !== "submitting") continue;
      const state = e.target_kind === "new" && !e.pane_id ? "starting" : "sending";
      if (!this.store.claim(e.id, ["submitting"], state)) continue;
      // The legacy sending trigger is conservative. No input has been attempted yet.
      this.store.update(e.id, { input_attempted: 0 });
      this.busy.add(e.id);
      this.track(this.deliver(e, state === "starting"));
    }
    this.changed();
  }

  machine(id: string): Machine | undefined {
    return this.machines.find((m) => m.id === id);
  }

  machineLabel(id: string): string {
    return this.machine(id)?.label ?? id;
  }

  view(machineId: string): MachineView | undefined {
    return this.views.get(machineId);
  }

  /** Keeps a machine's agents fresh while a page shows them. */
  watch(machineId: string): () => void {
    this.watched.set(machineId, (this.watched.get(machineId) ?? 0) + 1);
    this.lastPoll.delete(machineId);
    this.track(this.tick());
    return () => {
      const n = (this.watched.get(machineId) ?? 1) - 1;
      if (n <= 0) this.watched.delete(machineId);
      else this.watched.set(machineId, n);
    };
  }

  async refreshMachines(): Promise<void> {
    this.machinesAt = Date.now();
    try {
      const profiles: MachineProfile[] = await machineList();
      this.machines = [
        { id: LOCAL, label: localLabel(), enabled: true, target: null },
        ...profiles.map((p) => ({ id: p.id, label: p.label, enabled: p.enabled, target: p.target })),
      ];
      this.machinesError = null;
    } catch (error) {
      this.machinesError = message(error);
    }
    this.changed();
  }

  /** Re-read one machine now. */
  async refresh(machineId: string): Promise<void> {
    let read = this.polling.get(machineId);
    if (!read) {
      read = this.poll(machineId);
      this.polling.set(machineId, read);
      this.track(read);
    }
    await read;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (Date.now() - this.machinesAt > MACHINES_REFRESH_MS) this.track(this.refreshMachines());
    const now = Date.now();
    for (const machineId of this.watched.keys()) {
      const every = machineId === LOCAL ? this.timing.localPollMs : this.timing.remotePollMs;
      if (now - (this.lastPoll.get(machineId) ?? 0) < every) continue;
      this.track(this.refresh(machineId));
    }
  }

  private async poll(machineId: string): Promise<void> {
    this.lastPoll.set(machineId, Date.now());
    const previous = this.views.get(machineId);
    if (!previous) this.views.set(machineId, { agents: [], panes: [], workspaces: [], at: 0, error: null, loading: true });
    try {
      const [agents, workspaces, panes] = await Promise.all([agentList(machineId), workspaceList(machineId), paneList(machineId)]);
      const manual = this.store.db.query<{ id: number }, [string]>("SELECT e.id FROM executions e JOIN continuations c ON c.key = 'execution:' || e.id WHERE e.machine_id = ? AND json_extract(c.data, '$.manual_required') = 1").all(machineId);
      const bindings = new Map(manual.flatMap(({ id }) => { const b = this.store.continuation(`execution:${id}`); return b ? [[b.terminal_id, b] as const] : []; }));
      await Promise.all([...bindings.values()].map(b => refreshManual(machineId, b)));
      // stopped while herdr answered: the store may be on its way out
      if (this.stopped) return;
      this.views.set(machineId, { agents, panes, workspaces, at: Date.now(), error: null, loading: false });
      // A terminal can switch conversations after a send. Later reports alone cannot
      // fill missing historical identity; discovery or explicit confirmation must do that.
    } catch (error) {
      if (this.stopped) return;
      const view = this.views.get(machineId)!;
      this.views.set(machineId, { ...view, error: message(error), loading: false });
    } finally {
      this.polling.delete(machineId);
      this.lastPoll.set(machineId, Date.now());
      if (!this.stopped) this.changed();
    }
  }

  private async deliver(original: Execution, create: boolean): Promise<void> {
    let attempted = false;
    try {
      if (!this.machine(original.machine_id)?.enabled) throw new Error("机器不可用，请恢复连接后手动重试");
      if (create) await this.startAgent(original);
      const e = this.store.execution(original.id)!;
      const round = this.store.getRound(e.round_id);
      if (!e.pane_id || !round) throw new Error("广播目标或轮次不存在");
      const manualBinding = this.store.continuation(continuationKey(e));
      const manual = e.agent_kind === "custom" || manualBinding?.manual_required === true;
      const response = await submitPrompt(e.machine_id, e.pane_id, round.prompt, async () => {
        if (e.agent_kind === "codex") {
          const blocked = codexInputBlock(await paneRead(e.machine_id, e.pane_id!, 40, "visible"));
          if (blocked) {
            if (create && !attempted) await this.waitForStartupConfirmation(e.id, e.agent_name!);
            else throw new HerdrError("agent_blocked", blocked + "；未发送消息，请处理后手动重试");
          }
        }
        if (manual) {
          const binding = manualBinding;
          if (!binding || this.store.continuation(continuationKey(e))?.manual_process?.token !== binding.manual_process?.token
            || !await refreshManual(e.machine_id, binding) || binding.pane_id !== e.pane_id || binding.terminal_id !== e.terminal_id) throw new Error("人工绑定的进程已退出、替换或无法核实，请重新确认后发送");
          this.store.update(e.id, { state: "sending", input_attempted: 1, sent_at: this.store.execution(e.id)!.sent_at ?? Date.now() });
          attempted = true; return;
        }
        // Do this inside the terminal write lock, so identity cannot go stale while another paste ends.
        const agent = await agentGet(e.machine_id, e.pane_id!);
        // A second check before raw fallback must retain identity learned by the first check.
        const current = this.store.execution(e.id)!;
        const issue = resumeIdentityIssue(this.store, current, agent);
        if (issue) throw new Error(issue === "changed" ? "目标终端已切换到其他会话，未发送消息" : "无法确认原会话身份，未发送消息；请确认后手动重试");
        if (create && agent.name !== e.agent_name) throw new Error("新建 agent 已被替换或改名，消息未发送；请检查后手动重试");
        if (agent.agent_status === "blocked") throw new HerdrError("agent_blocked", "Agent 正在等待确认，未发送消息；处理后请手动重试");
        const kind = agent.agent ?? agent.display_agent ?? current.agent_kind;
        const session = agent.agent_session;
        if (session?.value && (session.agent !== kind || !["id", "path"].includes(session.kind))) throw new Error("Agent 上报的会话身份无效，消息未发送");
        this.store.update(e.id, {
          state: "sending", input_attempted: 1,
          sent_at: this.store.execution(e.id)!.sent_at ?? Date.now(),
          terminal_id: agent.terminal_id, workspace_id: agent.workspace_id, tab_id: agent.tab_id,
          cwd: agent.foreground_cwd ?? agent.cwd ?? current.cwd, agent_kind: kind,
          session_kind: session?.value ? session.kind : current.session_kind, session_value: session?.value || current.session_value,
        });
        if (session?.value && !this.store.continuation(`identity:${e.id}`)) this.store.rememberIdentitySource(this.store.execution(e.id)!, "query");
        attempted = true;
      }, manual);
      if (response) {
        const sent = this.store.execution(e.id)!;
        const session = response.agent_session;
        if (response.pane_id !== sent.pane_id || !sent.terminal_id || response.terminal_id !== sent.terminal_id
          || (response.agent ?? response.display_agent) !== sent.agent_kind
          || (session?.value && (session.agent !== sent.agent_kind || !["id", "path"].includes(session.kind)
            || (sent.session_value && (session.value !== sent.session_value || session.kind !== sent.session_kind))))) {
          throw new Error("发送返回的会话身份与目标不一致，无法确认投递到原会话；请检查终端，不会自动重发");
        }
        // This submission's receipt is evidence; an unrelated later poll is not.
        if (!sent.session_value && session?.value) {
          this.store.update(e.id, { session_kind: session.kind, session_value: session.value });
          this.store.rememberIdentitySource(this.store.execution(e.id)!, "prompt");
        }
      }
      this.store.update(e.id, { state: "sent", note: null, error: null, owner_pid: null });
      const sent = this.store.execution(e.id)!;
      if (this.dispatching && sent.agent_kind !== "custom" && (!sent.session_value || manualBinding?.native_pending)) {
        const wait = new AbortController();
        this.identityWaits.set(e.id, wait);
        this.track(acquireIdentity(this.store, sent, wait.signal, this.timing.identityWaitMs, this.verifyIdentity)
          .catch(() => { /* An unavailable identity never rewrites a successful submission. */ })
          .finally(() => { this.identityWaits.delete(e.id); if (!this.stopped) { this.track(this.refresh(e.machine_id)); this.changed(); } }));
      }
    } catch (error) {
      const refused = error instanceof HerdrError && ["agent_blocked", "agent_not_ready", "agent_not_found", "pane_not_found"].includes(error.code);
      const uncertain = attempted && !refused;
      this.store.update(original.id, {
        state: uncertain ? "uncertain" : error instanceof StartupSendCancelled ? "cancelled" : "failed", input_attempted: attempted && !refused ? 1 : 0,
        ...(refused ? { sent_at: null } : {}), owner_pid: null, error: message(error),
        note: uncertain ? "可能已发送。请检查 agent 的对话或原生队列，再决定是否重试；不会自动重发。" : null,
      });
    } finally {
      this.busy.delete(original.id);
      this.changed();
      if (!this.stopped) this.track(this.refresh(original.machine_id));
    }
  }

  /** Creates and starts a new agent as part of this submission, without saving deferred work. */
  private async startAgent(e: Execution): Promise<void> {
    this.changed();
    const broadcast = this.store.getBroadcast(e.broadcast_id);
    if (!broadcast) return;
    const kind = e.agent_kind ?? "claude";
    const cwd = resolveCwd(e.machine_id, e.cwd ?? "~");
    const args = await this.launchArgs(e.machine_id, kind);
    this.store.update(e.id, { note: "正在创建工作区…" });
    const created = await this.placeFor(e, broadcast.title, cwd);
    const pane = created.root_pane?.pane_id;
    if (!pane) throw new Error("Herdr 没有返回新 pane 的 ID");
    this.store.update(e.id, {
      workspace_id: created.workspace?.workspace_id ?? created.root_pane?.workspace_id ?? null,
      workspace_label: created.workspace?.label ?? null,
      tab_id: created.tab?.tab_id ?? created.root_pane?.tab_id ?? null,
      pane_id: pane,
      terminal_id: created.root_pane?.terminal_id ?? null,
      note: `正在启动 ${kind}…`,
    });
    const name = e.agent_name ?? agentNameFor(e.broadcast_id, kind, e.slot);
    let startResponse: AgentInfo | null = null;
    for (let attempt = 1; ; attempt += 1) {
      try {
        startResponse = await this.startWatched(e.machine_id, { name, kind, pane, timeoutMs: 90_000, args });
        break;
      } catch (error) {
        if (error instanceof HerdrError && error.code === "agent_not_ready") {
          await this.waitForStartupConfirmation(e.id, name);
          break;
        }
        // a pane made a moment ago may not be at its shell prompt yet
        const retryable = !(error instanceof LaunchFailedError) && !(error instanceof HerdrError && (error.code === "usage" || error.code === "timeout")) && attempt < 6;
        if (retryable) {
          await sleep(1_500);
          continue;
        }
        // what the shell shows says more than a timeout: the page shows it beside the error
        if (error instanceof HerdrError && error.code === "timeout") {
          const shown = launchFailureText(await paneRead(e.machine_id, pane).catch(() => ""));
          throw new Error(`${kind} 没有在 90 秒内就绪${shown ? `。终端最后显示：\n${shown}` : ""}`);
        }
        throw error;
      }
    }
    const agent = await agentGet(e.machine_id, pane);
    if (agent.pane_id !== pane || !created.root_pane?.terminal_id || agent.terminal_id !== created.root_pane.terminal_id
      || (agent.agent ?? agent.display_agent) !== kind || agent.name !== name) throw new Error("启动的 agent 或终端已变化，消息未发送；请检查后手动重试");
    const session = startResponse?.agent_session;
    if (session?.value) {
      if (startResponse!.pane_id !== pane || startResponse!.terminal_id !== agent.terminal_id || (startResponse!.agent ?? startResponse!.display_agent) !== kind
        || session.agent !== kind || !["id", "path"].includes(session.kind)
        || (agent.agent_session?.value && (session.value !== agent.agent_session.value || session.kind !== agent.agent_session.kind || agent.agent_session.agent !== kind))) throw new Error("启动返回的会话身份与目标不一致，消息未发送");
      this.store.update(e.id, { session_kind: session.kind, session_value: session.value });
      this.store.rememberIdentitySource(this.store.execution(e.id)!, "start");
    }
    this.store.update(e.id, {
      agent_name: name,
      note: null,
    });
  }

  private abortStartupWaits(): void {
    for (const wait of this.startupWaits.values()) wait.abort(new Error("服务正在停止或重启，启动确认等待已结束，消息未发送；需要时请手动重试"));
  }

  canCancelStartup(id: number): boolean { return this.startupWaits.has(id) && !this.startupWaits.get(id)!.signal.aborted; }

  /** Cancels only this request's unsent startup wait, never an agent's own work. */
  cancelStartup(id: number): boolean {
    if (!this.canCancelStartup(id)) return false;
    this.startupWaits.get(id)!.abort(new StartupSendCancelled("已取消本次发送，消息未发送；agent 保持打开"));
    return true;
  }

  /** A bounded part of the accepted launch, not persistent work for a later dispatcher. */
  private async waitForStartupConfirmation(id: number, name: string): Promise<void> {
    if (!this.dispatching) throw new Error("服务正在停止或重启，消息未发送；请手动重试");
    const e = this.store.execution(id)!;
    const wait = new AbortController();
    this.startupWaits.set(id, wait);
    this.store.update(id, { agent_name: name, note: "等待完成 agent 启动确认，完成后自动发送本轮任务；最多等待 5 分钟，可取消本次发送。" });
    this.changed();
    try {
      const before = await agentGet(e.machine_id, e.pane_id!);
      const check = (agent: AgentInfo) => {
        if (!agent || agent.pane_id !== e.pane_id || !e.terminal_id || agent.terminal_id !== e.terminal_id
          || (agent.agent ?? agent.display_agent) !== (e.agent_kind ?? "claude") || agent.name !== name) {
          throw new Error("启动确认期间 agent 或终端已变化，消息未发送；请检查后手动重试");
        }
      };
      check(before);
      wait.signal.throwIfAborted();
      const deadline = Date.now() + this.timing.startupConfirmMs;
      let ready: AgentInfo;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new HerdrError("timeout", "startup confirmation timed out");
        ready = await agentWaitReady(e.machine_id, e.pane_id!, remaining, wait.signal);
        wait.signal.throwIfAborted();
        check(ready);
        if (e.agent_kind !== "codex" || !codexInputBlock(await paneRead(e.machine_id, e.pane_id!, 40, "visible"))) break;
        await sleepUnless(Math.min(500, remaining), wait.signal);
        wait.signal.throwIfAborted();
      }
      // Check again after reading the screen; never accept a replacement occupant.
      check(await agentGet(e.machine_id, e.pane_id!));
      if (!READY.includes(ready.agent_status)) throw new Error("Agent 尚未就绪，消息未发送；请检查后手动重试");
      if (before.agent_session?.value && (ready.agent_session?.value !== before.agent_session.value
        || ready.agent_session?.kind !== before.agent_session.kind || ready.agent_session?.agent !== before.agent_session.agent)) {
        throw new Error("启动确认期间会话已变化，消息未发送；请检查后手动重试");
      }
    } catch (error) {
      if (wait.signal.aborted) throw wait.signal.reason;
      if (error instanceof HerdrError && error.code === "timeout") throw new Error("等待启动确认超时，消息未发送；处理终端提示后请手动重试");
      throw error;
    } finally {
      this.startupWaits.delete(id);
      this.changed();
    }
  }

  /**
   * `agent start`, watching the pane meanwhile: when the shell says the command could not run,
   * Herdr would still wait out its whole timeout. The start is stopped then, with the shell's words.
   */
  private async startWatched(machine: string, opts: { name: string; kind: string; pane: string; timeoutMs: number; args?: string[] }): Promise<AgentInfo | null> {
    const stop = new AbortController();
    // what the pane shows before anything is typed, so an old line is not taken for this launch's
    const before = await paneRead(machine, opts.pane).catch(() => "");
    const start = agentStart(machine, { ...opts, signal: stop.signal });
    let failed: string | null = null;
    const watch = (async () => {
      while (!stop.signal.aborted) {
        await sleepUnless(this.timing.launchPollMs, stop.signal);
        if (stop.signal.aborted) return;
        const now = await paneRead(machine, opts.pane).catch(() => null);
        if (now === null) continue;
        // only what came after the screen as it was: a fresh pane's history is its prompt
        const added = now.startsWith(before.trimEnd()) ? now.slice(before.trimEnd().length) : now;
        if (LAUNCH_FAILED.test(added)) {
          failed = launchFailureText(added);
          stop.abort();
          return;
        }
      }
    })();
    try {
      return await start;
    } catch (error) {
      if (failed !== null) throw new LaunchFailedError(`${opts.kind} 无法在这台机器上启动：\n${failed}`, failed);
      throw error;
    } finally {
      stop.abort();
      await watch;
    }
  }

  /**
   * A broadcast's new agents on one machine share one workspace, a tab each, every tab in its own
   * agent's folder: one broadcast is one workspace to find and to close.
   */
  private async placeFor(e: Execution, title: string, cwd: string): Promise<Created> {
    const label = workspaceLabelFor(e.broadcast_id, title);
    const key = `${e.broadcast_id}\0${e.machine_id}`;
    const previous = this.groupLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const sibling = this.store.executions(e.broadcast_id).find((other) =>
        other.id !== e.id && other.machine_id === e.machine_id && other.target_kind === "new" && other.workspace_id !== null);
      const tabLabel = tabLabelFor(e.agent_kind ?? "agent", e.slot, cwd);
      if (sibling?.workspace_id) {
        try {
          const tab = await tabCreate(e.machine_id, { workspace: sibling.workspace_id, cwd, label: tabLabel });
          return { ...tab, workspace: tab.workspace ?? ({ workspace_id: sibling.workspace_id, label: sibling.workspace_label ?? label } as WorkspaceInfo) };
        } catch (error) {
          // the shared workspace was closed: open a new one
          if (!(error instanceof HerdrError)) throw error;
        }
      }
      const created = await workspaceCreate(e.machine_id, { cwd, label });
      // the workspace's root tab carries the first agent; name it like the others
      if (created.tab?.tab_id) await tabRename(e.machine_id, created.tab.tab_id, tabLabel).catch(() => undefined);
      // recorded now so the next agent in this group finds it
      this.store.update(e.id, { workspace_id: created.workspace?.workspace_id ?? null, workspace_label: created.workspace?.label ?? label });
      return created;
    });
    this.groupLocks.set(key, run);
    try { return await run; }
    finally { if (this.groupLocks.get(key) === run) this.groupLocks.delete(key); }
  }

  // ---- user actions ----------------------------------------------------------------------

  /** Retry is a new round in the verified original conversation; history stays intact. */
  async retry(original: Execution) {
    const e = this.store.execution(original.id);
    if (!e || !["failed", "uncertain", "cancelled", "lost", "interrupted"].includes(e.state)) throw new Error("只有失败或结果不确定的发送记录可以重试");
    const existingRetry = this.store.retryRound(e.id);
    if (existingRetry) return existingRetry;
    if (!this.machine(e.machine_id)?.enabled) throw new Error("请先启用或连接原机器");
    let target: Execution;
    const fresh = { ...e, pane_id: null, terminal_id: null, workspace_id: null, workspace_label: null, tab_id: null, agent_name: null };
    if (!e.pane_id && unsentNewExecution(e)) target = fresh;
    else {
      const [agents, panes] = await Promise.all([agentList(e.machine_id), paneList(e.machine_id)]);
      const found = conversationTarget(this.store, e, agents, panes);
      if (found?.mode === "reconnect") target = { ...found.execution, target_kind: "existing" };
      else if (unsentNewExecution(e)) target = fresh;
      else throw new Error("请先点击「恢复原会话」，在终端确认恢复后，再次发送本轮任务。旧任务不会自动重发。");
    }
    // A concurrent refresh may have changed the record while the machine answered.
    if (this.store.execution(e.id)?.state !== e.state) throw new Error("任务状态已变化，请重新检查后再发送");
    this.assertAccepting();
    const round = this.store.createRetryRound(e, { ...target, continuation_source: continuationKey(e), parent_execution_id: e.id });
    this.submit(round.id);
    this.changed();
    return round;
  }

  /** Interrupt the current agent, without rewriting any message's delivery result. */
  async interrupt(e: Execution, terminalId: unknown): Promise<void> {
    if (!this.machine(e.machine_id)?.enabled) throw new Error("请先恢复机器连接");
    const agent = await agentGet(e.machine_id, e.pane_id!);
    if (typeof terminalId !== "string" || agent.terminal_id !== terminalId || resumeIdentityIssue(this.store, e, agent)) throw new Error("会话身份已变化，请重新检查，未发送中断请求");
    await paneSendKeys(e.machine_id, e.pane_id!, ["ctrl+c"]);
    await this.refresh(e.machine_id);
  }

  /** Shows the execution's agent in Herdr's own UI. */
  async focus(e: Execution): Promise<string> {
    if (!e.pane_id) throw new Error("这个执行还没有 pane");
    try {
      await agentFocus(e.machine_id, e.pane_id);
    } catch {
      if (e.workspace_id) await workspaceFocus(e.machine_id, e.workspace_id);
      if (e.tab_id) await tabFocus(e.machine_id, e.tab_id);
    }
    return e.machine_id === LOCAL ? "已切换到该 agent" : `已在 ${this.machineLabel(e.machine_id)} 上聚焦该 agent；在 Herdr 侧栏切到这台机器即可看到`;
  }
}
