/**
 * Broadcasts and their executions, in SQLite under the plugin's state directory.
 *
 * A broadcast contains rounds; each round has a prompt and one execution per participating agent.
 * The Web service records immediate delivery attempts. Conditional claims prevent duplicate
 * submissions; interrupted attempts become history to inspect, never work to replay.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Legacy task states remain readable; new records only describe delivery. */
export type ExecState =
  | "submitting" // this user request is being submitted, never picked up by a scheduler
  | "starting" // starting a new recipient within this request
  | "sending" // writing a prompt
  | "sent" // terminal submission returned successfully, not proof of AI completion
  | "uncertain" // input may have reached the agent; no automatic retry
  | "failed"
  | "queued" | "working" | "blocked" | "interrupting" | "interrupted" | "completed" | "cancelled" | "lost";

export const ACTIVE_STATES: readonly ExecState[] = ["submitting", "starting", "sending"];
export const FINAL_STATES: readonly ExecState[] = ["sent", "uncertain", "completed", "failed", "cancelled", "lost", "interrupted", "working", "blocked", "interrupting"];

export type TargetKind = "existing" | "new";

export interface Broadcast {
  id: number;
  title: string;
  prompt: string;
  created_at: number;
}

export interface Round {
  id: number;
  broadcast_id: number;
  number: number;
  prompt: string;
  created_at: number;
}

export interface RoundSummary extends Round {
  total: number;
  counts: Partial<Record<ExecState, number>>;
}

export interface BroadcastSummary extends Broadcast {
  round_count: number;
  latest_at: number;
  total: number;
  counts: Partial<Record<ExecState, number>>;
}

export interface Execution {
  id: number;
  broadcast_id: number;
  round_id: number;
  /** "local" or a saved machine profile id */
  machine_id: string;
  machine_label: string;
  target_kind: TargetKind;
  agent_kind: string | null;
  agent_name: string | null;
  cwd: string | null;
  /** new agents: the agent's place among the broadcast's new agents on this machine (1-based) */
  slot: number;
  workspace_id: string | null;
  workspace_label: string | null;
  tab_id: string | null;
  pane_id: string | null;
  terminal_id: string | null;
  session_kind: string | null;
  session_value: string | null;
  state: ExecState;
  /** Legacy lifecycle tracking metadata; not used to infer delivery or completion. */
  seq_before: number | null;
  saw_working: number;
  /** 0: proven no task input attempted; 1: sending claimed/attempted; null: legacy unknown. */
  input_attempted: number | null;
  error: string | null;
  /** Delivery explanation shown with the history. */
  note: string | null;
  /** when Ctrl+C was last requested; an agent still working well after it was not interrupted */
  interrupt_requested_at: number | null;
  owner_pid: number | null;
  created_at: number;
  sent_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

export type NewExecution = Pick<Execution, "machine_id" | "machine_label" | "target_kind"> &
  Partial<Pick<Execution, "agent_kind" | "agent_name" | "cwd" | "slot" | "workspace_id" | "workspace_label" | "tab_id" | "pane_id" | "terminal_id" | "session_kind" | "session_value">>;

/** A replacement terminal for a saved conversation; the original broadcast stays immutable. */
export interface Continuation {
  key: string;
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  workspace_label: string;
  tab_id: string;
  status: "starting" | "ready" | "launched" | "uncertain";
  error: string | null;
  /** A legacy execution with no session ref opened the agent's own session picker. */
  select_session?: boolean;
  /** The user confirmed their selection when Herdr could not report its identity. */
  confirmed_session?: boolean;
  discovery_note?: string;
  failure_kind?: "unavailable";
}

export const SCHEMA_VERSION = 9;

/**
 * One database per Herdr session: pane ids and "local" mean that session's server, and a hook
 * running in another session must not take this one's panes for gone.
 */
export function sessionName(): string {
  if (process.env.HERDR_BROADCAST_SESSION) return process.env.HERDR_BROADCAST_SESSION;
  const match = /[/\\]sessions[/\\]([^/\\]+)[/\\]herdr\.sock$/.exec(process.env.HERDR_SOCKET_PATH ?? "");
  return match?.[1] ?? "default";
}

export function defaultDbPath(createDirectory = true): string {
  // outside Herdr (a shell, a script), the same directory Herdr gives the plugin
  const dir = process.env.HERDR_PLUGIN_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdr", "plugins", "herdr-broadcast");
  if (createDirectory) mkdirSync(dir, { recursive: true });
  const session = sessionName();
  return join(dir, session === "default" ? "broadcast.sqlite" : `broadcast-${session.replace(/[^A-Za-z0-9_.-]/g, "_")}.sqlite`);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export class Store {
  readonly db: Database;

  constructor(readonly path: string = defaultDbPath(), options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      this.db = new Database(path, { readonly: true });
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;");
      return;
    }
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.transaction(() => {
      const { user_version } = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
      if (user_version > SCHEMA_VERSION) throw new Error("数据库版本较新，不能由旧服务打开");
      if (user_version === SCHEMA_VERSION) return;
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS broadcasts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS executions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
          machine_id TEXT NOT NULL,
          machine_label TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          agent_kind TEXT,
          agent_name TEXT,
          cwd TEXT,
          slot INTEGER NOT NULL DEFAULT 0,
          workspace_id TEXT,
          workspace_label TEXT,
          tab_id TEXT,
          pane_id TEXT,
          terminal_id TEXT,
          session_kind TEXT,
          session_value TEXT,
          state TEXT NOT NULL,
          seq_before INTEGER,
          saw_working INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          note TEXT,
          owner_pid INTEGER,
          created_at INTEGER NOT NULL,
          sent_at INTEGER,
          finished_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS executions_broadcast ON executions(broadcast_id);
        CREATE INDEX IF NOT EXISTS executions_state ON executions(state);
        CREATE TABLE IF NOT EXISTS locks (
          name TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          heartbeat INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS continuations (
          key TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );
      `);
      // version 3 and before started agents in git worktrees too: those columns go
      const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(executions)").all().map((c) => c.name));
      // Existing empty timestamps are not proof that an older sender wrote no input.
      if (!columns.has("input_attempted")) this.db.exec("ALTER TABLE executions ADD COLUMN input_attempted INTEGER");
      if (!columns.has("interrupt_requested_at")) this.db.exec("ALTER TABLE executions ADD COLUMN interrupt_requested_at INTEGER");
      for (const column of ["worktree_branch", "trust_repository"]) {
        if (columns.has(column)) this.db.exec(`ALTER TABLE executions DROP COLUMN ${column}`);
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS broadcast_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (broadcast_id, number)
      )`);
      if (!columns.has("round_id")) this.db.exec("ALTER TABLE executions ADD COLUMN round_id INTEGER REFERENCES broadcast_rounds(id) ON DELETE CASCADE");
      // Preserve legacy broadcast/execution IDs and results; every old broadcast is round one.
      this.db.exec(`INSERT INTO broadcast_rounds (broadcast_id, number, prompt, created_at)
        SELECT id, 1, prompt, created_at FROM broadcasts
        WHERE NOT EXISTS (SELECT 1 FROM broadcast_rounds r WHERE r.broadcast_id = broadcasts.id);
        UPDATE executions SET round_id = (SELECT id FROM broadcast_rounds r WHERE r.broadcast_id = executions.broadcast_id AND r.number = 1) WHERE round_id IS NULL;
        CREATE INDEX IF NOT EXISTS executions_round ON executions(round_id);
        CREATE TABLE IF NOT EXISTS execution_retries (
          execution_id INTEGER PRIMARY KEY REFERENCES executions(id) ON DELETE CASCADE,
          round_id INTEGER NOT NULL REFERENCES broadcast_rounds(id) ON DELETE CASCADE
        );
        CREATE TRIGGER IF NOT EXISTS executions_input_attempt
        AFTER UPDATE OF state ON executions WHEN NEW.state = 'sending' AND OLD.state != 'sending'
        BEGIN
          UPDATE executions SET input_attempted = 1 WHERE id = NEW.id;
        END;
        PRAGMA user_version = ${SCHEMA_VERSION}`);
    }).immediate();
  }

  /**
   * Takes a named lock for this process, unless a live process holds it with a fresh heartbeat.
   * A holder that died, or stopped beating for `staleMs`, loses it.
   */
  acquireLock(name: string, isAlive: (pid: number) => boolean, staleMs: number, pid: number = process.pid): boolean {
    const take = this.db.transaction(() => {
      const held = this.db.query<{ pid: number; heartbeat: number }, [string]>("SELECT pid, heartbeat FROM locks WHERE name = ?").get(name);
      if (held && held.pid !== pid && isAlive(held.pid) && Date.now() - held.heartbeat < staleMs) return false;
      this.db.query("INSERT INTO locks (name, pid, heartbeat) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET pid = excluded.pid, heartbeat = excluded.heartbeat").run(name, pid, Date.now());
      return true;
    });
    return take.immediate();
  }

  heartbeat(name: string, pid: number = process.pid): void {
    this.db.query("UPDATE locks SET heartbeat = ? WHERE name = ? AND pid = ?").run(Date.now(), name, pid);
  }

  releaseLock(name: string, pid: number = process.pid): void {
    this.db.query("DELETE FROM locks WHERE name = ? AND pid = ?").run(name, pid);
  }

  /** The live holder of a lock, if any. */
  lockHolder(name: string, isAlive: (pid: number) => boolean, staleMs: number): number | null {
    const held = this.db.query<{ pid: number; heartbeat: number }, [string]>("SELECT pid, heartbeat FROM locks WHERE name = ?").get(name);
    return held && isAlive(held.pid) && Date.now() - held.heartbeat < staleMs ? held.pid : null;
  }

  activeCount(): number {
    return this.db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM executions WHERE state IN (${placeholders(ACTIVE_STATES)})`).get(...ACTIVE_STATES)!.n;
  }

  close(): void {
    this.db.close();
  }

  createBroadcast(input: { title: string; prompt: string; executions: NewExecution[] }): number {
    const now = Date.now();
    const insert = this.db.transaction(() => {
      const { id } = this.db.query<{ id: number }, [string, string, number]>("INSERT INTO broadcasts (title, prompt, created_at) VALUES (?, ?, ?) RETURNING id").get(input.title, input.prompt, now)!;
      this.createRound(id, input.prompt, input.executions);
      return id;
    });
    return insert.immediate();
  }

  /** Append atomically, so concurrent clients receive distinct, consecutive round numbers. */
  createRound(broadcastId: number, prompt: string, executions: NewExecution[]): Round {
    return this.db.transaction(() => {
      const now = Date.now();
      const round = this.db.query<Round, [number, string, number, number]>(`INSERT INTO broadcast_rounds (broadcast_id, number, prompt, created_at)
        SELECT ?, COALESCE(MAX(number), 0) + 1, ?, ? FROM broadcast_rounds WHERE broadcast_id = ? RETURNING *`).get(broadcastId, prompt, now, broadcastId)!;
      const row = this.db.prepare(`INSERT INTO executions (broadcast_id, round_id, machine_id, machine_label, target_kind, agent_kind, agent_name, cwd, slot,
        workspace_id, workspace_label, tab_id, pane_id, terminal_id, session_kind, session_value, input_attempted, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'submitting', ?, ?)`);
      for (const e of executions) {
        row.run(broadcastId, round.id, e.machine_id, e.machine_label, e.target_kind, e.agent_kind ?? null, e.agent_name ?? null, e.cwd ?? null, e.slot ?? 0,
          e.workspace_id ?? null, e.workspace_label ?? null, e.tab_id ?? null, e.pane_id ?? null, e.terminal_id ?? null, e.session_kind ?? null, e.session_value ?? null, now, now);
      }
      return round;
    }).immediate();
  }

  getRound(id: number): Round | null {
    return this.db.query<Round, [number]>("SELECT * FROM broadcast_rounds WHERE id = ?").get(id) ?? null;
  }

  rounds(broadcastId: number): RoundSummary[] {
    const rounds = this.db.query<Round, [number]>("SELECT * FROM broadcast_rounds WHERE broadcast_id = ? ORDER BY number").all(broadcastId);
    const summaries = new Map<number, RoundSummary>(rounds.map(r => [r.id, { ...r, total: 0, counts: {} }]));
    const counts = this.db.query<{ round_id: number; state: ExecState; n: number }, [number]>("SELECT round_id, state, COUNT(*) AS n FROM executions WHERE broadcast_id = ? GROUP BY round_id, state").all(broadcastId);
    for (const c of counts) {
      const summary = summaries.get(c.round_id)!;
      summary.counts[c.state] = c.n;
      summary.total += c.n;
    }
    return [...summaries.values()];
  }

  listBroadcasts(): BroadcastSummary[] {
    const broadcasts = this.db.query<Broadcast & { round_count: number; latest_at: number }, []>(`SELECT b.*, COUNT(r.id) AS round_count, MAX(r.created_at) AS latest_at
      FROM broadcasts b JOIN broadcast_rounds r ON r.broadcast_id = b.id GROUP BY b.id ORDER BY latest_at DESC, b.id DESC`).all();
    const counts = this.db.query<{ broadcast_id: number; state: ExecState; n: number }, []>("SELECT broadcast_id, state, COUNT(*) AS n FROM executions GROUP BY broadcast_id, state").all();
    const byId = new Map<number, BroadcastSummary>(broadcasts.map((b) => [b.id, { ...b, total: 0, counts: {} }]));
    for (const c of counts) {
      const summary = byId.get(c.broadcast_id);
      if (!summary) continue;
      summary.counts[c.state] = c.n;
      summary.total += c.n;
    }
    return [...byId.values()];
  }

  getBroadcast(id: number): Broadcast | null {
    return this.db.query<Broadcast, [number]>("SELECT id, title, prompt, created_at FROM broadcasts WHERE id = ?").get(id) ?? null;
  }

  deleteBroadcast(id: number): void {
    this.db.query("DELETE FROM broadcasts WHERE id = ?").run(id);
  }

  executions(broadcastId: number): Execution[] {
    return this.db.query<Execution, [number]>("SELECT * FROM executions WHERE broadcast_id = ? ORDER BY id").all(broadcastId);
  }

  execution(id: number): Execution | null {
    return this.db.query<Execution, [number]>("SELECT * FROM executions WHERE id = ?").get(id) ?? null;
  }

  continuation(key: string): Continuation | null {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM continuations WHERE key = ?").get(key);
    return row ? JSON.parse(row.data) : null;
  }

  saveContinuation(value: Continuation): void {
    this.db.query("INSERT INTO continuations (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
      .run(value.key, JSON.stringify(value));
  }

  /** Keep the last real name on every broadcast referring to this conversation. */
  rememberAgentName(e: Execution, name: string): void {
    this.db.query(`UPDATE executions SET agent_name = ?, updated_at = ?
      WHERE machine_id = ? AND agent_kind IS ? AND (
        (session_kind IS ? AND session_value = ?)
        OR (session_value IS NULL AND pane_id = ? AND terminal_id = ?)
      )`).run(name, Date.now(), e.machine_id, e.agent_kind, e.session_kind, e.session_value, e.pane_id, e.terminal_id);
  }

  retryRound(executionId: number): Round | null {
    const row = this.db.query<{ round_id: number }, [number]>("SELECT round_id FROM execution_retries WHERE execution_id = ?").get(executionId);
    return row ? this.getRound(row.round_id) : null;
  }

  /** A repeated HTTP request or another client must not submit the same retry twice. */
  createRetryRound(e: Execution, target: NewExecution): Round {
    return this.db.transaction(() => {
      const existing = this.retryRound(e.id);
      if (existing) return existing;
      const round = this.createRound(e.broadcast_id, this.getRound(e.round_id)!.prompt, [target]);
      this.db.query("INSERT INTO execution_retries (execution_id, round_id) VALUES (?, ?)").run(e.id, round.id);
      return round;
    }).immediate();
  }

  executionsIn(states: readonly ExecState[]): Execution[] {
    return this.db.query<Execution, string[]>(`SELECT * FROM executions WHERE state IN (${placeholders(states)}) ORDER BY id`).all(...states);
  }

  /** Moves an execution from one of `from` to `to` only if nobody else moved it first. */
  claim(id: number, from: readonly ExecState[], to: ExecState, ownerPid: number = process.pid): boolean {
    const now = Date.now();
    // a final state ends the run here, as update() would record it
    const finished = (FINAL_STATES as readonly string[]).includes(to) ? ", finished_at = ?" : "";
    // RETURNING counts the claimed row independently of trigger bookkeeping writes.
    const result = this.db.query(`UPDATE executions SET state = ?, owner_pid = ?, updated_at = ?${finished} WHERE id = ? AND state IN (${placeholders(from)}) RETURNING id`)
      .get(to, ownerPid, now, ...(finished ? [now] : []), id, ...from);
    return result !== null;
  }

  update(id: number, patch: Partial<Omit<Execution, "id" | "broadcast_id" | "round_id">>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const now = Date.now();
    const state = patch.state;
    if (state && (FINAL_STATES as readonly string[]).includes(state) && patch.finished_at === undefined) entries.push(["finished_at", now]);
    entries.push(["updated_at", now]);
    const sql = `UPDATE executions SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`;
    this.db.query(sql).run(...(entries.map(([, value]) => value) as (string | number | null)[]), id);
  }

  /** Retire the previous scheduler's records without replaying any prompt. Schema stays v9. */
  retireLegacyQueue(): void {
    this.db.transaction(() => {
      for (const e of this.executionsIn(["queued"])) {
        const unsent = e.input_attempted === 0 && e.sent_at === null;
        this.update(e.id, { state: unsent ? "cancelled" : "uncertain", owner_pid: null,
          note: unsent ? "旧版排队记录已停止，消息未发送；需要时请手动重新发送。"
            : "旧版排队记录无法确认是否尝试过输入；请检查原对话后决定是否重试，不会自动发送。", error: null });
      }
      for (const e of this.executionsIn(["working", "blocked", "interrupting"])) {
        this.update(e.id, { state: "sent", owner_pid: null, note: "旧版已发送记录；后续执行由 agent 处理，不再推断本条消息是否完成。" });
      }
      for (const e of this.executionsIn(["sent"])) {
        if (e.note?.includes("发送超时")) this.update(e.id, { state: "uncertain" });
      }
    }).immediate();
  }

  /** An interrupted submission becomes a result to inspect, never pending work to resume. */
  recoverAbandoned(isAlive: (pid: number) => boolean): number {
    let recovered = 0;
    for (const e of this.executionsIn(ACTIVE_STATES)) {
      if (e.owner_pid !== null && isAlive(e.owner_pid)) continue;
      const uncertain = e.input_attempted !== 0;
      this.update(e.id, { state: uncertain ? "uncertain" : "failed", owner_pid: null,
        error: uncertain ? "发送时服务意外退出，无法确认是否送达。请检查原对话后手动重试。"
          : "发送操作因服务退出而中止，未发送消息。请检查原终端后手动重试。" });
      recovered += 1;
    }
    return recovered;
  }

}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
