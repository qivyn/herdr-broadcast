/** Conversation identity shared by tracking, sending and user actions. */
import { ACTIVE_STATES, type Continuation, type Execution, type Store } from "./db.ts";
import type { AgentInfo, PaneInfo, WorkspaceInfo } from "./herdr-types.ts";
import { manualValid } from "./manual-session.ts";

export const continuationKey = (e: Execution) => e.session_value
  ? JSON.stringify([e.machine_id, e.agent_kind, e.session_kind, e.session_value]) : `execution:${e.id}`;

/** No task input was attempted: a failed launch can safely start in a fresh terminal. */
export function unsentNewExecution(e: Execution): boolean {
  return e.target_kind === "new" && e.input_attempted === 0 && !e.session_value && e.sent_at === null && e.seq_before === null && e.saw_working === 0;
}

/** History preferences must never move an execution that is still being tracked. */
export function executionContinuation(store: Store, e: Execution): Continuation | null {
  const binding = store.continuation(continuationKey(e));
  return binding && ACTIVE_STATES.includes(e.state)
    && (binding.pane_id !== e.pane_id || binding.terminal_id !== e.terminal_id) ? null : binding;
}

export const terminalBindingKey = (e: Execution, t: Pick<Execution, "pane_id" | "terminal_id"> = e) =>
  `terminal:${JSON.stringify([e.machine_id, e.agent_kind, e.session_kind, e.session_value, t.pane_id, t.terminal_id])}`;

/** Native restore/manual confirmation is evidence about one physical terminal, not a history preference. */
export function rememberTerminalIdentity(store: Store, e: Execution, t: Continuation): void {
  if (!e.session_value) return;
  const key = terminalBindingKey(e, t);
  if (store.continuation(key)?.status !== "launched") store.saveContinuation({ ...t, key, status: "launched", error: null });
}

function rejectTerminalIdentity(store: Store, e: Execution, a: AgentInfo): "changed" {
  if (e.session_value && a.pane_id === e.pane_id && a.terminal_id === e.terminal_id) {
    for (const key of [terminalBindingKey(e), continuationKey(e)]) {
      const binding = store.continuation(key);
      if (binding?.status === "launched" && binding.pane_id === a.pane_id && binding.terminal_id === a.terminal_id) {
        store.saveContinuation({ ...binding, status: "uncertain", confirmed_session: false, error: "终端曾报告其他会话，请重新核对原会话后确认。" });
      }
    }
  }
  return "changed";
}

export function sameSession(e: Execution, a: AgentInfo): boolean {
  return !!e.session_value && a.agent_session?.kind === e.session_kind && a.agent_session.value === e.session_value
    && a.agent_session.agent === e.agent_kind && (a.agent ?? a.display_agent) === e.agent_kind;
}

export class ConversationIdentityError extends Error {
  constructor(readonly state: "identity_pending" | "conflict", message: string) { super(message); }
}

function originalAgent(e: Execution, a: AgentInfo): boolean {
  return a.pane_id === e.pane_id && !!e.terminal_id && a.terminal_id === e.terminal_id
    && (!e.agent_kind || (a.agent ?? a.display_agent) === e.agent_kind)
    && (e.session_value ? sameSession(e, a) : ACTIVE_STATES.includes(e.state) || unsentNewExecution(e) || !e.agent_kind);
}

/** `shell`: a pane where an agent is being started, or failed to start: no conversation in it yet. */
export type Target = { execution: Execution; mode: "reconnect" | "inspect"; unverified_original?: boolean; shell?: boolean };

/** Missing reports are not evidence of a new session, but must not authorize a send. */
export function resumeIdentityIssue(store: Store, e: Execution, a: AgentInfo): "changed" | "unconfirmed" | null {
  if (a.pane_id !== e.pane_id || (e.terminal_id && a.terminal_id !== e.terminal_id)
    || (e.agent_kind && (a.agent ?? a.display_agent) !== e.agent_kind)) return rejectTerminalIdentity(store, e, a);
  if (!e.session_value) {
    if (ACTIVE_STATES.includes(e.state) || unsentNewExecution(e) || !e.agent_kind) return null;
    const binding = executionContinuation(store, e);
    return binding?.status === "launched" && binding.confirmed_session && !a.agent_session?.value
      && binding.pane_id === a.pane_id && binding.terminal_id === a.terminal_id ? null : "unconfirmed";
  }
  if (a.agent_session?.value) return sameSession(e, a) ? null : rejectTerminalIdentity(store, e, a);
  const trusted = store.continuation(terminalBindingKey(e));
  if (trusted?.status === "launched") return null;
  const binding = executionContinuation(store, e);
  return binding?.status === "launched" && binding.pane_id === a.pane_id && binding.terminal_id === a.terminal_id ? null : "unconfirmed";
}
function at(e: Execution, location: Pick<Continuation, "pane_id" | "terminal_id" | "workspace_id" | "tab_id">, label = e.workspace_label): Execution {
  return { ...e, pane_id: location.pane_id, terminal_id: location.terminal_id, workspace_id: location.workspace_id, tab_id: location.tab_id, workspace_label: label };
}

/** No lookup by pane ID alone: IDs can be reused after a server restart. */
export function conversationTarget(store: Store, e: Execution, agents: AgentInfo[], panes: PaneInfo[], workspaces: WorkspaceInfo[] = []): Target | null {
  const active = ACTIVE_STATES.includes(e.state);
  if (active) {
    agents = agents.filter(a => a.pane_id === e.pane_id && !!e.terminal_id && a.terminal_id === e.terminal_id);
    panes = panes.filter(p => p.pane_id === e.pane_id && !!e.terminal_id && p.terminal_id === e.terminal_id);
  }
  const binding = executionContinuation(store, e);
  const located = (location: Parameters<typeof at>[1], fallback?: string | null) => at(e, location,
    workspaces.find(w => w.workspace_id === location.workspace_id)?.label
      ?? fallback ?? (location.workspace_id === e.workspace_id ? e.workspace_label : null));
  const connected = (agent: AgentInfo, source = e): Target => {
    const execution = { ...located(agent, binding?.terminal_id === agent.terminal_id ? binding.workspace_label : null),
      session_kind: source.session_kind, session_value: source.session_value };
    execution.agent_kind ??= agent.agent ?? agent.display_agent ?? null;
    return { execution, mode: "reconnect" };
  };
  if (e.agent_kind === "custom" || binding?.manual_required) {
    const pane = panes.find(p => p.pane_id === (binding?.pane_id ?? e.pane_id) && p.terminal_id === (binding?.terminal_id ?? e.terminal_id));
    if (!pane) return null;
    return { execution: located(pane, binding?.workspace_label), mode: binding && manualValid(e.machine_id, binding) ? "reconnect" : "inspect", unverified_original: true };
  }
  if (binding) {
    const pane = panes.find(p => p.pane_id === binding.pane_id && p.terminal_id === binding.terminal_id);
    const bound = agents.find(a => a.pane_id === binding.pane_id && a.terminal_id === binding.terminal_id);
    if (bound && sameSession(e, bound)) return connected(bound);
    if (bound && binding.select_session && !e.session_value && (bound.agent ?? bound.display_agent) === e.agent_kind) {
      const session = bound.agent_session;
      if (session?.value && session.agent === e.agent_kind) {
        const selected = { ...e, session_kind: session.kind, session_value: session.value };
        store.update(e.id, { session_kind: session.kind, session_value: session.value });
        store.rememberIdentitySource(store.execution(e.id)!, "picker");
        store.saveContinuation({ ...binding, key: continuationKey(selected), select_session: false, status: "ready", error: null });
        return connected(bound, selected);
      }
    }
    // A confirmation without an ID does not authorize adopting a later report:
    // the same physical terminal may have switched sessions in the meantime.
    if (bound && !e.session_value && !binding.select_session && binding.status !== "starting"
      && (bound.agent ?? bound.display_agent) === e.agent_kind && bound.agent_session?.agent === e.agent_kind && bound.agent_session.value) {
      return { execution: located(bound, binding.workspace_label), mode: "inspect", unverified_original: true };
    }
    if (bound && ((bound.agent ?? bound.display_agent) !== e.agent_kind || bound.agent_session?.value)) {
      rejectTerminalIdentity(store, located(bound), bound);
      throw new ConversationIdentityError("conflict", "所选终端已切换到其他会话，请重新选择原会话实例。");
    }
    if (bound) {
      const legacyStarted = binding.status === "uncertain" && !binding.select_session && !!e.session_value
        && binding.error === "启动命令已执行，尚未确认原会话标识；请检查终端提示" && bound.interactive_ready === true;
      if (binding.status === "launched" || legacyStarted || (e.session_value && !resumeIdentityIssue(store, located(bound), bound))) {
        if (legacyStarted) store.saveContinuation({ ...binding, status: "launched", error: null });
        rememberTerminalIdentity(store, e, binding);
        return { execution: located(bound, binding.workspace_label), mode: "reconnect" };
      }
      // Keep the explicit instance while reports are absent, even if another copy reports the same session.
      return { execution: located(bound, binding.workspace_label), mode: "inspect" };
    }
    if (pane && binding.status !== "ready" && !agents.some(a => a.pane_id === pane.pane_id)) return { execution: located(pane, binding.workspace_label), mode: "inspect" };
  }
  const matches = agents.filter((a) => sameSession(e, a));
  const original = agents.find(a => a.pane_id === e.pane_id && a.terminal_id === e.terminal_id);
  if (original && e.session_value && (original.agent_session?.value || (original.agent ?? original.display_agent) !== e.agent_kind)) resumeIdentityIssue(store, e, original);
  const agent = matches.find((a) => a.pane_id === binding?.pane_id && a.terminal_id === binding.terminal_id)
    ?? agents.find((a) => originalAgent(e, a))
    ?? (matches.length === 1 ? matches[0] : undefined);
  if (agent) {
    return connected(agent);
  }
  if (matches.length > 1) throw new ConversationIdentityError("conflict", "原会话在多个终端中打开。请在 Herdr 中关闭多余实例，系统会自动恢复连接。");
  const unverified = agents.find(a => a.pane_id === e.pane_id && a.terminal_id === e.terminal_id
    && !!e.agent_kind && (a.agent ?? a.display_agent) === e.agent_kind && (!e.session_value || !a.agent_session?.value));
  if (unverified) {
    if (!resumeIdentityIssue(store, e, unverified)) return { execution: located(unverified), mode: "reconnect" };
    if (unverified.interactive_ready === true || (!e.session_value && (unverified.agent_session?.agent === e.agent_kind && unverified.agent_session.value
      || ["idle", "done", "working"].includes(unverified.agent_status)))) {
      return { execution: located(unverified), mode: "inspect", unverified_original: true };
    }
    throw new ConversationIdentityError("identity_pending", e.session_value
      ? "原终端仍在运行，但尚未报告会话标识。系统正在自动确认身份，确认后会自动连接；不会重复启动。"
      : "原终端仍在运行，但无法确认原会话身份。请等待 agent 就绪后核对并确认；不会重复启动。");
  }
  // Plain terminal executions have no agent session, but still require the original terminal ID.
  if (!e.agent_kind && !e.session_value) {
    const pane = panes.find((p) => p.pane_id === e.pane_id && p.terminal_id === e.terminal_id);
    if (pane) return { execution: located(pane), mode: "reconnect" };
  }
  // A newly created shell is already inspectable while agent.start waits for readiness (Herdr
  // lists a placeholder agent meanwhile), and stays so after a launch that failed in it before any
  // task input: the shell's own words, "command not found", are the explanation.
  const unsentStart = e.target_kind === "new" && e.input_attempted === 0 && e.sent_at === null && ["failed", "lost"].includes(e.state);
  if ((e.state === "starting" || unsentStart) && !e.session_value && e.terminal_id) {
    const pane = panes.find(p => p.pane_id === e.pane_id && p.terminal_id === e.terminal_id);
    if (pane && !agents.some(a => a.pane_id === pane.pane_id && !a.launch_pending)) return { execution: located(pane), mode: "inspect", shell: true };
  }
  return null;
}
