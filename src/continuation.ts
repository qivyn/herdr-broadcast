/** Reconnect to a live conversation, or launch its exact saved session without a prompt. */
import { FINAL_STATES, pidAlive, type Continuation, type Execution, type Store } from "./db.ts";
import type { Engine } from "./engine.ts";
import { resolveCwd, unsentNewExecution } from "./engine.ts";
import { agentList, agentStart, herdrResult, HerdrError, paneList, workspaceCreate, workspaceList, type Created } from "./herdr.ts";
import type { AgentInfo } from "./herdr-types.ts";
import { continuationKey, conversationTarget, executionContinuation, rememberTerminalIdentity, sameSession, ConversationIdentityError, type Target } from "./conversation-target.ts";
export { continuationKey, conversationTarget, resumeIdentityIssue } from "./conversation-target.ts";
import { sessionFileReadable } from "./session-file.ts";
import { discoverSession } from "./session-discovery.ts";

export class RestoreUnavailableError extends Error {}

const RESTORE_LOCK_MS = 300_000;

/** A persisted launch is pending only while its live process still owns the launch lock. */
function recoverAbandonedRestore(store: Store, e: Execution): void {
  const key = continuationKey(e);
  if (store.continuation(key)?.status !== "starting") return;
  store.db.transaction(() => {
    const binding = store.continuation(key);
    if (binding?.status !== "starting" || store.lockHolder(`continue:${key}`, pidAlive, RESTORE_LOCK_MS) !== null) return;
    store.saveContinuation({ ...binding, status: "uncertain", error: "恢复服务曾中断。请检查原恢复终端，确认会话后继续；不会重复启动或发送任务。" });
  }).immediate();
}

/** Exact saved sessions; selecting one manually is a separate, explicit operation. */
export function resumeArgs(e: Execution): string[] | null {
  if (e.agent_kind === "pi" && e.session_kind === "path" && e.session_value?.startsWith("/")
    && e.session_value.endsWith(".jsonl") && !/[\x00-\x1f\x7f]/.test(e.session_value)) return ["--session", e.session_value];
  if (e.session_kind !== "id" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.session_value ?? "")) return null;
  if (e.agent_kind === "claude") return ["--resume", e.session_value!];
  if (e.agent_kind === "codex") return ["resume", e.session_value!];
  if (e.agent_kind === "pi") return ["--session", e.session_value!];
  return null;
}

export function sessionPickerArgs(kind: string | null): string[] | null {
  if (kind === "claude" || kind === "pi") return ["--resume"];
  if (kind === "codex") return ["resume"];
  return null;
}

export function resumeUnavailable(e: Execution, chooseSession = false): string | null {
  if (!FINAL_STATES.includes(e.state)) return "本次发送尚未结束，请稍后恢复会话";
  if (!e.session_value) {
    if (!chooseSession) return "未保存原会话标识，请打开 agent 手动选择原会话";
    if (!sessionPickerArgs(e.agent_kind)) return "此 agent 暂不支持从本页打开会话选择器";
  } else if (!resumeArgs(e)) return "此会话暂不支持自动恢复（支持 Claude Code、Codex、Pi 的会话 ID，以及 Pi 会话文件）";
  if (!e.cwd) return "未保存原工作目录，无法恢复会话";
  return null;
}

function confirmationReady(e: Execution, binding: Continuation | null, agents: AgentInfo[]): boolean {
  return !!binding && !(binding.select_session && e.session_value) && binding.status !== "starting" && agents.some(a => a.pane_id === binding.pane_id
    && a.terminal_id === binding.terminal_id && (a.agent ?? a.display_agent) === e.agent_kind
    && a.interactive_ready === true && !a.agent_session?.value);
}

export function continuationInfo(store: Store, engine: Engine, e: Execution) {
  const machine = engine.machine(e.machine_id), view = engine.view(e.machine_id);
  if (!machine?.enabled || view?.error) return { execution: e, terminal_state: "unreachable",
    requires_action: !machine?.enabled || /permission denied|authentication fail|host key verification failed|host identification has changed|machine_not_found/i.test(view?.error || ""),
    resume_reason: !machine ? "原机器的连接配置已删除，请在「机器」页面重新配置。" : !machine.enabled ? "原机器已停用，请在「机器」页面启用。"
      : "暂时无法连接原机器，系统会自动重连。若长期无法恢复，请检查机器或 SSH 设置。", can_resume: false };
  if (!e.pane_id && (unsentNewExecution(e) || ["submitting", "queued", "starting", "cancelled"].includes(e.state))) return { execution: e, terminal_state: "not_started", can_resume: false,
    resume_reason: e.state === "failed" ? "Agent 未能启动。修复错误后可点击「再次发送本轮任务」。" : e.state === "cancelled" ? "本轮已取消，任务没有发送。" : "Agent 尚未启动，启动后会自动发送本轮任务。" };
  if (!view?.at || view.loading) return { execution: e, terminal_state: "checking", resume_reason: "正在检查原终端", can_resume: false };
  try {
    recoverAbandonedRestore(store, e);
    const target = conversationTarget(store, e, view.agents, view.panes, view.workspaces);
    const saved = executionContinuation(store, e);
    if (target?.mode !== "reconnect" && saved?.failure_kind === "unavailable") return { execution: target?.execution || e,
      terminal_state: "closed", can_resume: false, restore_unavailable: true, resume_reason: saved.error };
    if (target) {
      const binding = executionContinuation(store, e);
      // the shell where this agent is being started, or failed to start: no conversation here yet
      if (target.shell) return { execution: target.execution, terminal_state: "shell", can_resume: false,
        resume_reason: e.state === "failed" ? e.error || `未能启动 ${e.agent_kind ?? "agent"}。终端里是这台机器的输出。` : "正在启动 agent，终端里是它的输出；就绪后会自动发送任务。" };
      if (e.state === "starting" && !binding) return { execution: target.execution, terminal_state: "starting", can_resume: false,
        resume_reason: "Agent 正在启动。请在终端完成信任目录等启动确认，完成后自动发送本轮任务。" };
      const error = target.mode === "inspect" ? binding?.error : null;
      const readyToConfirm = target.unverified_original === true || confirmationReady(e, binding, view.agents);
      const reason = binding?.select_session
        ? readyToConfirm ? "无法自动识别所选会话。请确认终端中已打开原对话，再点「确认已恢复原会话」。" : `请在下方终端选择原会话，完成后会自动检查。${binding?.discovery_note || ""}`
        : readyToConfirm ? !e.session_value
          ? "发送时未保存会话标识，当前终端可能已切换对话。请核对原对话后，再点「确认已恢复原会话」。"
          : "Agent 已就绪，但无法自动确认会话。请核对终端中的原对话，再点「确认已恢复原会话」。"
          : error ? `恢复尚未完成，请检查下方终端。详情：${error}` : "请在下方终端完成启动确认；不会重新发送任务。";
      return { execution: target.execution, terminal_state: target.mode === "inspect" ? "restoring" : "live",
        can_confirm_session: target.mode === "inspect" && readyToConfirm,
        restore_kind: binding?.select_session ? "choose" : readyToConfirm ? "identity" : "confirm",
        restore_pending: binding?.status === "starting",
        can_abandon_restore: target.mode === "inspect" && !!binding && binding.status !== "starting",
        resume_reason: target.mode === "inspect" ? reason : null, can_resume: false };
    }
    const choose = !e.session_value && !!sessionPickerArgs(e.agent_kind);
    if (e.state === "starting") return { execution: e, terminal_state: "not_started", can_resume: false, resume_reason: "正在准备 agent，启动后自动连接并发送任务。" };
    if (["failed", "lost"].includes(e.state) && unsentNewExecution(e)) return { execution: e, terminal_state: "not_started", can_resume: false,
      resume_reason: "Agent 未能启动，任务尚未发送。修复启动条件后，可点击「再次发送本轮任务」在新终端中重试。" };
    const reason = resumeUnavailable(e, choose);
    return { execution: e, terminal_state: "closed", resume_mode: choose ? "choose" : "saved",
      resume_reason: reason || (choose ? "将查找原机器上的历史会话，找到唯一匹配后直接恢复；无法确定时打开会话选择器" : null), can_resume: !reason };
  } catch (error) {
    return { execution: e, terminal_state: error instanceof ConversationIdentityError ? error.state : "conflict", resume_reason: String((error as Error).message), can_resume: false };
  }
}

export class Conversations {
  private pending = new Map<string, Promise<{ mode: string; message: string }>>();
  constructor(private store: Store, private engine: Engine, private changed: () => void,
    private fileReadable = sessionFileReadable, private discover = discoverSession) {}

  async settle() { await Promise.allSettled([...this.pending.values()]); }

  async options(e: Execution) {
    if (!this.engine.machine(e.machine_id)?.enabled) throw new Error("机器不可用");
    return (await agentList(e.machine_id)).filter(a => sameSession(e, a)).map(a => ({
      terminal_id: a.terminal_id, label: a.name || a.foreground_cwd || a.cwd || e.agent_kind || "对话",
    }));
  }

  async selectTarget(e: Execution, terminalId: unknown): Promise<void> {
    if (!this.engine.machine(e.machine_id)?.enabled) throw new Error("机器不可用");
    const agents = await agentList(e.machine_id);
    const agent = agents.find(a => a.terminal_id === terminalId && sameSession(e, a));
    if (!agent) throw new Error("对话已变化");
    const previous = this.store.continuation(continuationKey(e));
    if (previous?.status === "launched" && agents.some(a => a.pane_id === previous.pane_id && a.terminal_id === previous.terminal_id
      && (a.agent ?? a.display_agent) === e.agent_kind && !a.agent_session?.value)) rememberTerminalIdentity(this.store, e, previous);
    this.store.saveContinuation({ key: continuationKey(e), pane_id: agent.pane_id, terminal_id: agent.terminal_id,
      workspace_id: agent.workspace_id, tab_id: agent.tab_id, workspace_label: e.workspace_label || "对话", status: "ready", error: null });
    await this.engine.refresh(e.machine_id);
    this.changed();
  }

  async abandon(e: Execution, terminalId: unknown): Promise<void> {
    if (this.pending.has(continuationKey(e)) || this.store.lockHolder(`continue:${continuationKey(e)}`, pidAlive, 300_000) !== null) throw new Error("恢复命令还在执行，请等待启动结果后再关闭");
    if (!this.engine.machine(e.machine_id)?.enabled) throw new Error("请先恢复机器连接");
    const binding = this.store.continuation(continuationKey(e));
    const target = await this.target(e);
    if (!binding || !target || target.mode !== "inspect" || terminalId !== binding.terminal_id) throw new Error("恢复终端已变化，请等待状态自动更新");
    const agent = (await agentList(e.machine_id)).find(a => a.pane_id === binding.pane_id && a.terminal_id === terminalId);
    if (agent?.agent_status === "working") throw new Error("终端中还有任务运行，请先在终端中断后再关闭");
    await herdrResult(["pane", "close", binding.pane_id], { machine: e.machine_id });
    await this.engine.refresh(e.machine_id);
    this.changed();
  }

  /** Fresh read for a socket/action: a cached screen must never grant input to a replacement. */
  async target(e: Execution): Promise<Target | null> {
    const machine = this.engine.machine(e.machine_id);
    if (!machine?.enabled) throw new Error("这台机器不存在或已停用");
    const [agents, panes, workspaces] = await Promise.all([agentList(e.machine_id), paneList(e.machine_id), workspaceList(e.machine_id)]);
    recoverAbandonedRestore(this.store, e);
    return conversationTarget(this.store, e, agents, panes, workspaces);
  }

  /** Explicit user confirmation only; readiness alone does not prove the picker was completed. */
  async confirmSession(e: Execution, terminalId: unknown): Promise<void> {
    if (!this.engine.machine(e.machine_id)?.enabled) throw new Error("机器不可用，请先恢复机器连接");
    const [agents, panes] = await Promise.all([agentList(e.machine_id), paneList(e.machine_id)]);
    const current = this.store.execution(e.id);
    if (!current || continuationKey(current) !== continuationKey(e)) throw new Error("会话身份已变化，请刷新后确认");
    recoverAbandonedRestore(this.store, e);
    const target = conversationTarget(this.store, e, agents, panes);
    if (!target || typeof terminalId !== "string" || target.execution.terminal_id !== terminalId) throw new Error("终端已变化，请刷新后确认");
    if (target.mode === "reconnect") return;
    if (target.unverified_original) {
      const t = target.execution;
      const agent = agents.find(a => a.pane_id === t.pane_id && a.terminal_id === terminalId)!;
      const session = agent.agent_session?.agent === e.agent_kind ? agent.agent_session : null;
      const confirmed = !e.session_value && session?.value ? { ...e, session_kind: session.kind, session_value: session.value } : e;
      const binding: Continuation = { key: continuationKey(confirmed), pane_id: t.pane_id!, terminal_id: t.terminal_id!, workspace_id: t.workspace_id!,
        tab_id: t.tab_id!, workspace_label: t.workspace_label || "对话", status: "launched", confirmed_session: true, select_session: false, error: null };
      this.store.db.transaction(() => {
        if (!e.session_value) {
          if (confirmed.session_value) this.store.update(e.id, { session_kind: confirmed.session_kind, session_value: confirmed.session_value });
          this.store.saveContinuation(binding);
        }
        rememberTerminalIdentity(this.store, confirmed, binding);
      }).immediate();
      await this.engine.refresh(e.machine_id); this.changed(); return;
    }
    const binding = this.store.continuation(continuationKey(e));
    if (!binding || !confirmationReady(e, binding, agents)) throw new Error("请先在恢复终端里打开原会话，等待 agent 就绪后再确认");
    this.store.saveContinuation({ ...binding, status: "launched", confirmed_session: true, select_session: false, error: null });
    rememberTerminalIdentity(this.store, e, binding);
    await this.engine.refresh(e.machine_id);
    this.changed();
  }

  continue(e: Execution, chooseSession = false, automatic = false) {
    const key = continuationKey(e);
    const pendingKey = automatic ? `reconnect:${key}` : key;
    const pending = this.pending.get(pendingKey);
    if (pending) return pending;
    const work = this.run(e, key, chooseSession, automatic).finally(() => this.pending.delete(pendingKey));
    this.pending.set(pendingKey, work);
    return work;
  }

  private async run(original: Execution, key: string, chooseSession: boolean, automatic: boolean): Promise<{ mode: string; message: string }> {
    recoverAbandonedRestore(this.store, original);
    const lock = `continue:${key}`;
    if (!automatic && (this.store.lockHolder(lock, pidAlive, RESTORE_LOCK_MS) !== null || !this.store.acquireLock(lock, pidAlive, RESTORE_LOCK_MS))) throw new Error("这个会话正在恢复，请稍候");
    let binding: Continuation | null = null;
    try {
      const e = this.store.execution(original.id);
      if (!e) throw new Error("广播记录已删除");
      if (continuationKey(e) !== key) return await this.continue(e, chooseSession, automatic);
      const target = await this.target(e);
      if (target) return { mode: target.mode, message: target.mode === "reconnect" ? "已找到原会话，正在重新连接" : "已打开之前的恢复终端，请检查其中的启动提示" };
      // Delivery state cannot tell us why an agent exited. Automatic callers may
      // reconnect to a live target, but only an explicit request may start a process.
      if (automatic) return { mode: "manual", message: "对话已关闭；需要时请点击「继续对话」。" };
      const broadcast = this.store.getBroadcast(e.broadcast_id)!;
      let discoveryNote: string | undefined;
      if (chooseSession && !e.session_value && !resumeUnavailable(e, true)) {
        const found = await this.discover(e, { ...broadcast, prompt: this.store.getRound(e.round_id)!.prompt });
        if (found.status === "found" && found.session && resumeArgs({ ...e, session_kind: found.session.kind, session_value: found.session.value })) {
          this.store.update(e.id, { session_kind: found.session.kind, session_value: found.session.value });
          // All broadcasts of a discovered session share the same launch lock.
          return await this.continue(this.store.execution(e.id)!, false, automatic);
        }
        discoveryNote = found.status === "ambiguous" ? "找到多个可能的历史会话，需要你手动选择。"
          : found.status === "unavailable" ? "历史记录暂时无法完整读取，已改为手动选择。" : "未找到唯一匹配的历史记录，已改为手动选择。";
      }
      const selecting = chooseSession && !e.session_value;
      const reason = resumeUnavailable(e, selecting);
      if (reason) throw new Error(reason);
      if (e.agent_kind === "pi" && e.session_kind === "path" && !await this.fileReadable(e.machine_id, e.session_value!)) {
        throw new RestoreUnavailableError("原机器上的 Pi 会话文件不存在、为空或不可读，无法恢复原对话");
      }
      const previous = this.store.continuation(key);
      if (previous && previous.status !== "ready") {
        const panes = await paneList(e.machine_id);
        if (panes.some((p) => p.pane_id === previous.pane_id && p.terminal_id === previous.terminal_id)) throw new Error("之前的恢复终端仍在，请先在 Herdr 中检查或关闭它；不会重复启动会话");
      }
      const created: Created = await workspaceCreate(e.machine_id, { cwd: resolveCwd(e.machine_id, e.cwd!), label: Array.from(`继续 · ${broadcast.title}`).slice(0, 36).join("") });
      const pane = created.root_pane;
      if (!pane?.pane_id || !pane.terminal_id) throw new Error("Herdr 没有返回恢复终端的完整信息，请在 Herdr 中检查");
      binding = { key, pane_id: pane.pane_id, terminal_id: pane.terminal_id, workspace_id: pane.workspace_id,
        tab_id: pane.tab_id, workspace_label: created.workspace?.label ?? "继续对话", status: "starting", error: null, select_session: selecting, discovery_note: discoveryNote };
      this.store.saveContinuation(binding);
      this.changed();
      // This is deliberately not engine.retry(): the broadcast prompt is never submitted.
      const name = `resume-${e.id}-${Date.now().toString(36)}`;
      let startSucceeded = false;
      for (let attempt = 0; ; attempt++) {
        try {
          await agentStart(e.machine_id, { name, kind: e.agent_kind!, pane: pane.pane_id,
            args: selecting ? sessionPickerArgs(e.agent_kind)! : resumeArgs(e)!, timeoutMs: selecting ? 5_000 : 90_000 });
          startSucceeded = true;
          break;
        } catch (error) {
          // Only this pre-launch rejection is safe to retry in the same new shell.
          if (error instanceof HerdrError && error.code === "agent_not_ready") break;
          // A picker waits for the user's choice, so it need not become idle yet.
          // Keep the one launch and expose its terminal instead of waiting 90 seconds.
          if (selecting && error instanceof HerdrError && error.code === "timeout") break;
          if (!(error instanceof HerdrError) || !["pane_busy", "agent_pane_busy"].includes(error.code) || attempt >= 5) throw error;
          await Bun.sleep(500);
        }
      }
      const agents = await agentList(e.machine_id);
      const restored = agents.find((a) => a.pane_id === pane.pane_id && a.terminal_id === pane.terminal_id && sameSession(e, a));
      const launched = !selecting && startSucceeded && agents.some((a) => a.pane_id === pane.pane_id && a.terminal_id === pane.terminal_id
        && (a.agent ?? a.display_agent) === e.agent_kind && !a.agent_session?.value);
      binding.status = restored ? "ready" : launched ? "launched" : "uncertain";
      binding.error = restored || launched || selecting ? null : "请在终端中完成启动或确认提示";
      this.store.saveContinuation(binding);
      if (launched) rememberTerminalIdentity(this.store, e, binding);
      return { mode: restored ? "resumed" : launched ? "opened" : selecting ? "choose" : "inspect",
        message: restored || launched ? "原会话已打开，未重新发送任务。需要接着做时，请发送新指令。" : selecting ? `${discoveryNote}请在下方终端选择原会话。` : binding.error! };
    } catch (error) {
      if (!binding) throw error;
      binding.status = "uncertain";
      binding.error = error instanceof Error ? error.message : String(error);
      if ((error instanceof HerdrError && ["session_not_found", "resume_not_found"].includes(error.code))
        || /(?:session|conversation).*(?:not found|does not exist)|(?:会话|对话).*(?:不存在|找不到)/i.test(binding.error)) binding.failure_kind = "unavailable";
      this.store.saveContinuation(binding);
      return { mode: "inspect", message: `恢复尚未确认，请检查已创建的终端：${binding.error}` };
    } finally {
      if (!automatic) this.store.releaseLock(lock);
      await this.engine.refresh(original.machine_id);
      this.changed();
    }
  }
}
