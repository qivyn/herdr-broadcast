/** Test setup: a fake herdr on HERDR_BIN_PATH with its state in a temp file, and a temp database. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeAgent {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  agent: string;
  name: string | null;
  agent_status: string;
  interactive_ready?: boolean;
  state_change_seq: number;
  completion_seq: number | null;
  cwd: string;
  agent_session?: { agent: string; kind: string; source: string; value: string } | null;
  custom?: boolean;
}

export interface FakeServer {
  processes?: Record<string, { pid: number; name: string }[]>;
  exitAfterPaste?: boolean;
  omitSessionReports?: boolean;
  next: number;
  workspaces: { workspace_id: string; label: string; active_tab_id: string }[];
  tabs: { tab_id: string; workspace_id: string; label: string }[];
  panes: { pane_id: string; tab_id: string; workspace_id: string; terminal_id: string; cwd: string }[];
  agents: FakeAgent[];
  prompts: { pane_id: string; text: string }[];
  /** text written into a pane with pane send-text, as the page's terminal does */
  typed?: { pane_id: string; text: string }[];
  failNext?: Record<string, string[]>;
  unreachable?: boolean;
  promptDelayMs?: number;
  promptReply?: Partial<FakeAgent> | null;
  promptRefusalSession?: FakeAgent["agent_session"];
  startDelayMs?: number;
  startScreen?: string;
  missingKinds?: string[];
  screens?: Record<string, string>;
}

export interface FakeState {
  machines: { id: string; label: string; target: string; session: string; enabled: boolean }[];
  servers: Record<string, FakeServer>;
  remotes?: Record<string, { install?: boolean; stopServer?: boolean }>;
}

export class FakeHerdr {
  readonly dir = mkdtempSync(join(tmpdir(), "herdr-broadcast-test-"));
  readonly stateFile = join(this.dir, "state.json");
  readonly logFile = join(this.dir, "calls.log");
  readonly dbFile = join(this.dir, "broadcast.sqlite");

  constructor() {
    const bin = join(this.dir, "herdr");
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-herdr.ts")}" "$@"\n`);
    chmodSync(bin, 0o755);
    process.env.HERDR_BIN_PATH = bin;
    process.env.FAKE_HERDR_STATE = this.stateFile;
    process.env.FAKE_HERDR_LOG = this.logFile;
    delete process.env.HERDR_BROADCAST_SESSION;
    delete process.env.FAKE_START_BLOCKED;
    this.write({ machines: [], servers: { local: emptyServer() } });
  }

  private write(state: FakeState): void {
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  read(): FakeState {
    return JSON.parse(readFileSync(this.stateFile, "utf8")) as FakeState;
  }

  server(machine = "local"): FakeServer {
    return this.read().servers[machine] ?? emptyServer();
  }

  /** Changes the fake's state under its lock, as a herdr server would change on its own. */
  mutate(change: (state: FakeState) => void): void {
    const lock = `${this.stateFile}.lock`;
    for (let i = 0; ; i += 1) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        if (i > 2000) throw new Error("lock timeout");
        Bun.sleepSync(2);
      }
    }
    try {
      const state = this.read();
      change(state);
      this.write(state);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  /** A server `machine add` will find wanting: Herdr to install, a server to stop first. */
  remote(target: string, needs: { install?: boolean; stopServer?: boolean }): void {
    this.mutate((s) => { (s.remotes ??= {})[target] = needs; });
  }

  addMachine(id: string, label: string): void {
    this.mutate((s) => {
      s.machines.push({ id, label, target: `${label}.example`, session: "default", enabled: true });
      s.servers[id] = emptyServer();
    });
  }

  /** An agent already running in its own workspace. */
  addAgent(machine: string, kind: string, status = "idle", name: string | null = null, custom = false): FakeAgent {
    let agent!: FakeAgent;
    this.mutate((s) => {
      const server = (s.servers[machine] ??= emptyServer());
      const n = server.next++;
      const ws = `w${n}`;
      server.workspaces.push({ workspace_id: ws, label: `project ${n}`, active_tab_id: `${ws}:t1` });
      server.tabs.push({ tab_id: `${ws}:t1`, workspace_id: ws, label: "1" });
      const pane = { pane_id: `${ws}:p1`, tab_id: `${ws}:t1`, workspace_id: ws, terminal_id: `term_${machine}_${n}`, cwd: `/src/p${n}` };
      server.panes.push(pane);
      agent = { ...pane, agent: kind, name, agent_status: status, state_change_seq: 10, completion_seq: 9, ...(custom ? { custom } : {}) };
      server.agents.push(agent);
    });
    return agent;
  }

  /** Moves an agent to a state the way Herdr numbers it: every change takes the next seq. */
  setStatus(machine: string, pane: string, status: string): void {
    this.mutate((s) => {
      const agent = s.servers[machine]!.agents.find((a) => a.pane_id === pane)!;
      const wasWorking = agent.agent_status === "working";
      agent.state_change_seq += 1;
      agent.agent_status = status;
      if ((status === "idle" || status === "done") && wasWorking) agent.completion_seq = agent.state_change_seq;
    });
  }

  /** A whole turn between two polls: working, then idle again. */
  quickTurn(machine: string, pane: string): void {
    this.setStatus(machine, pane, "working");
    this.setStatus(machine, pane, "done");
  }

  removeAgent(machine: string, pane: string): void {
    this.mutate((s) => {
      s.servers[machine]!.agents = s.servers[machine]!.agents.filter((a) => a.pane_id !== pane);
    });
  }

  calls(): string[] {
    return existsSync(this.logFile) ? readFileSync(this.logFile, "utf8").trim().split("\n").filter(Boolean) : [];
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function emptyServer(): FakeServer {
  return { next: 100, workspaces: [], tabs: [], panes: [], agents: [], prompts: [] };
}

/** Polls `check` until it holds or the time runs out. */
export async function until(check: () => boolean, timeoutMs = 8_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Launch policy fixture: real target capability probing has its own tests. */
export const fakeLaunchArgs = async (_machine: string, kind: string, args: string[] = []) => kind === "codex" ? ["--no-daemon", ...args] : args;
