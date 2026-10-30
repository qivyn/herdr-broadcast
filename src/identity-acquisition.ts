import type { Continuation, Execution, IdentityCheck, Store } from "./db.ts";
import { continuationKey } from "./conversation-target.ts";
import { agentGet } from "./herdr.ts";
import { canVerifySession, verifyReportedSession } from "./session-discovery.ts";
import { nativeResumeArgs } from "./agents.ts";
import { refreshManual } from "./manual-session.ts";

/** Scope is one live submission. Never instantiated by refresh, restart or history recovery. */
export async function acquireIdentity(store: Store, sent: Execution, signal: AbortSignal, timeoutMs: number, verify = verifyReportedSession): Promise<void> {
  const round = store.getRound(sent.round_id), broadcast = store.getBroadcast(sent.broadcast_id);
  if (!round || !broadcast || !sent.pane_id || !sent.terminal_id || !sent.agent_kind) return;
  const inherited = store.continuation(`execution:${sent.id}`);
  const check: IdentityCheck = { state: "waiting_report", started_at: Date.now() };
  const deadline = check.started_at + timeoutMs;
  const finish = (state: IdentityCheck["state"], reason?: IdentityCheck["reason"]) => {
    // A concurrent explicit confirmation owns its newer identity evidence.
    if (state !== "bound" && store.execution(sent.id)?.session_value) return;
    store.rememberIdentityCheck(sent, { ...check, state, reason, finished_at: Date.now() });
  };
  if (!canVerifySession(sent.agent_kind)) { finish("unsupported", "unsupported_agent"); return; }
  store.rememberIdentityCheck(sent, check);
  let reported: string | undefined;
  const matchesTarget = (a: Awaited<ReturnType<typeof agentGet>>) => a.pane_id === sent.pane_id && a.terminal_id === sent.terminal_id
    && (a.agent ?? a.display_agent) === sent.agent_kind;
  try {
    while (!signal.aborted && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 250); signal.addEventListener("abort", done, { once: true });
      });
      if (signal.aborted || Date.now() >= deadline) break;
      if (!store.execution(sent.id)) return; // History deletion ends its read-only check.
      const before = await agentGet(sent.machine_id, sent.pane_id).catch(() => null);
      if (!before) { finish("unavailable", "unreadable"); return; }
      if (!matchesTarget(before)) { finish("changed"); return; }
      const candidate = before.agent_session;
      if (!candidate?.value) {
        if (reported) { finish("changed"); return; }
        continue;
      }
      if (candidate.agent !== sent.agent_kind || !["id", "path"].includes(candidate.kind)
        || !nativeResumeArgs(sent.agent_kind, candidate.kind, candidate.value)) { finish("changed", "invalid_identity"); return; }
      const identity = JSON.stringify([candidate.kind, candidate.value]);
      if (reported && reported !== identity) { finish("changed"); return; }
      if (!reported) {
        reported = identity; check.state = "verifying"; check.reported_at = Date.now();
        store.rememberIdentityCheck(sent, check);
      }
      // A hook timestamp / pane / foreground PID alone does not prove which conversation got the text.
      const proof = await verify(sent, { ...broadcast, prompt: round.prompt }, { kind: candidate.kind as "id" | "path", value: candidate.value });
      if (signal.aborted || Date.now() >= deadline) break;
      if (proof.status === "none" || proof.reason === "incomplete") continue; // transcript may still be flushing
      if (proof.reason === "identity_mismatch" || proof.reason === "invalid_identity") { finish("changed", proof.reason); return; }
      if (proof.status === "unavailable") { finish("unavailable", proof.reason ?? "unreadable"); return; }
      if (proof.status !== "found" || proof.session?.kind !== candidate.kind || proof.session.value !== candidate.value) { finish("changed", "identity_mismatch"); return; }
      const after = await agentGet(sent.machine_id, sent.pane_id).catch(() => null);
      if (signal.aborted || Date.now() >= deadline) break;
      if (!after || !matchesTarget(after) || after.agent_session?.value !== candidate.value
        || after.agent_session.kind !== candidate.kind || after.agent_session.agent !== sent.agent_kind) { finish("changed"); return; }
      if (inherited?.manual_required && !await refreshManual(sent.machine_id, inherited)) { finish("changed"); return; }
      if (signal.aborted || Date.now() >= deadline) break;
      const bound = store.db.transaction(() => {
        const current = store.execution(sent.id);
        if (!current || current.state !== "sent" || current.pane_id !== sent.pane_id || current.terminal_id !== sent.terminal_id
          || (current.session_value && (current.session_value !== candidate.value || current.session_kind !== candidate.kind))) return false;
        const bind = (e: Execution, binding: Continuation | null) => {
          const updated = { ...e, session_kind: candidate.kind, session_value: candidate.value };
          store.update(e.id, { session_kind: candidate.kind, session_value: candidate.value });
          store.rememberIdentitySource({ ...updated, pane_id: sent.pane_id, terminal_id: sent.terminal_id,
            workspace_id: sent.workspace_id, tab_id: sent.tab_id, workspace_label: sent.workspace_label }, "history");
          if (binding) {
            const verified: Continuation = { ...binding, key: continuationKey(updated), status: "ready", error: null,
              native_pending: undefined, manual_required: false, manual_process: undefined, select_session: false, identity_source: "history" };
            store.saveContinuation(verified);
            store.saveContinuation({ ...verified, key: `execution:${e.id}` });
          }
        };
        const binding = store.continuation(`execution:${sent.id}`);
        // A re-confirmation/replacement during the read invalidates the old authority.
        if (binding?.native_pending?.token !== inherited?.native_pending?.token
          || (binding && (binding.pane_id !== sent.pane_id || binding.terminal_id !== sent.terminal_id))) return false;
        bind(current, binding);
        const intent = binding?.native_pending;
        if (!intent) return true;
        const original = store.execution(intent.execution_id), confirmed = store.continuation(`execution:${intent.execution_id}`);
        if (!original || original.session_value || original.machine_id !== sent.machine_id || original.agent_kind !== sent.agent_kind
          || confirmed?.native_pending?.token !== intent.token || confirmed.pane_id !== sent.pane_id || confirmed.terminal_id !== sent.terminal_id
          || !confirmed.confirmed_session) return true;
        // Follow the actual copied ancestry; never fill an unrelated unknown execution in this pane.
        let link: Continuation | null = binding;
        let reached = sent.id === original.id;
        const seen = new Set<number>([sent.id]);
        while (link?.parent_execution_id && !seen.has(link.parent_execution_id)) {
          const id = link.parent_execution_id;
          if (id === original.id) { reached = true; break; }
          seen.add(id); link = store.continuation(`execution:${id}`);
          if (link?.native_pending?.token !== intent.token) break;
        }
        if (reached) bind(original, confirmed);
        return true;
      }).immediate();
      finish(bound ? "bound" : "changed");
      return;
    }
    finish(signal.aborted ? "cancelled" : reported ? "proof_timeout" : "report_timeout");
  } catch { finish(signal.aborted ? "cancelled" : "unavailable", "unreadable"); }
}
