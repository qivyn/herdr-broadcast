/** A persistent Herdr controller, carried over one authenticated browser WebSocket.
 * Herdr owns the PTY. Only this CLI/SSH bridge is stopped when the browser leaves.
 */
import type { ServerWebSocket } from "bun";
import { herdrBin, LOCAL, machineList, routeArgs, type MachineProfile } from "../herdr.ts";
import type { Execution } from "../db.ts";
import { parseTarget } from "./ssh.ts";

const WINDOW = 256 * 1024;
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_INPUT = 64 * 1024;
/** input written to Herdr and not yet flushed: a long paste arrives as many messages in a row */
const MAX_BACKLOG = 1024 * 1024;
const STALL_MS = 15_000;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function terminalCommand(e: Pick<Execution, "machine_id" | "pane_id"> & Partial<Pick<Execution, "terminal_id">>, cols: number, rows: number, profiles: MachineProfile[] = [], takeover = false): string[] {
  if (!e.pane_id) throw new Error("这个 agent 还没有终端");
  // Pin retries to the original terminal, even if its pane is later reused.
  const args = ["terminal", "session", "control", e.terminal_id || e.pane_id, ...(takeover ? ["--takeover"] : []), "--cols", String(cols), "--rows", String(rows)];
  if (e.machine_id === LOCAL) return [herdrBin(), ...routeArgs(LOCAL), ...args];
  const profile = profiles.find((m) => m.id === e.machine_id);
  if (!profile?.enabled) throw new Error("这台机器不存在或已停用");
  const target = parseTarget(profile.target);
  // Interactive terminal commands are not forwarded by `herdr --machine`. Keep one SSH
  // connection to the saved profile, using its SSH config and named remote session.
  const remoteArgs = ["--session", profile.session || "default", ...args].map(quote).join(" ");
  const command = `for broadcast_bin in "$HOME/.local/bin/herdr" "$(command -v herdr 2>/dev/null)"; do if [ -x "$broadcast_bin" ]; then exec "$broadcast_bin" ${remoteArgs}; fi; done; echo 'Herdr executable not found' >&2; exit 127`;
  return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    ...(target.port ? ["-p", String(target.port)] : []), "--", target.user ? `${target.user}@${target.host}` : target.host, command];
}

export function terminalGeometry(cols: unknown, rows: unknown): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && Number(cols) >= 2 && Number(cols) <= 500 && Number(rows) >= 2 && Number(rows) <= 200;
}

export interface TerminalSocketData {
  execution: Execution;
  cols: number;
  rows: number;
  takeover?: boolean;
  bridge?: TerminalBridge;
}

export class TerminalBridge {
  private proc?: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  private stopped = false;
  private draining = false;
  private ready = false;
  private pendingInput = 0;
  private sent = 0;
  private acked = 0;
  private outstanding = 0;
  private frames = new Map<number, number>();
  private wake?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryWake?: () => void;
  readonly done: Promise<void>;
  get canInput(): boolean { return this.ready && !this.stopped && !this.draining; }

  constructor(private socket: ServerWebSocket<TerminalSocketData>) {
    this.timer = setTimeout(() => this.fail("终端连接超时，请重连"), STALL_MS);
    this.done = this.run();
  }

  private send(message: unknown): boolean {
    if (this.stopped) return false;
    // -1 means queued by Bun: it must never be sent a second time.
    if (this.socket.send(JSON.stringify(message)) === 0) { this.stop(); return false; }
    return true;
  }

  private async run(): Promise<void> {
    try {
      const e = this.socket.data.execution;
      const profiles = e.machine_id === LOCAL ? [] : await machineList();
      for (let attempt = 0; !this.stopped; attempt++) {
        let diagnostics = "";
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.fail("终端连接超时，请重连"), STALL_MS);
        // A user's takeover applies only to this attempt, never to later automatic retries.
        const takeover = attempt === 0 && this.socket.data.takeover === true;
        const proc = this.proc = Bun.spawn(terminalCommand(e, this.socket.data.cols, this.socket.data.rows, profiles, takeover), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
        const stderr = (async () => {
          const decoder = new TextDecoder();
          for await (const chunk of proc.stderr) diagnostics = (diagnostics + decoder.decode(chunk, { stream: true })).slice(-4000);
        })();
        const stdout = this.pump(proc.stdout).catch((error) => { this.fail(error instanceof Error ? error.message : String(error)); });
        const [code, closeReason] = await Promise.all([proc.exited, stdout, stderr]);
        if (closeReason) diagnostics = `${diagnostics}\n${closeReason}`;
        if (this.stopped) return;
        const held = !this.ready && /already has an attached client|retry with --takeover/i.test(diagnostics);
        const readRace = !this.ready && /has a read in progress; retry/i.test(diagnostics);
        if (held || (readRace && attempt < 5)) {
          clearTimeout(this.timer);
          this.proc = undefined;
          this.send({ type: "status", state: "waiting", canTakeover: held,
            message: "正在连接…" });
          if (this.stopped) return;
          await new Promise<void>((resolve) => {
            this.retryWake = resolve;
            this.retryTimer = setTimeout(resolve, Math.min(2000, 300 * 2 ** Math.min(attempt, 3)));
          });
          this.retryWake = undefined;
          continue;
        }
        this.fail(diagnostics.trim() || (code === 0 ? "终端连接已结束" : "终端连接失败，请确认 Herdr 支持 terminal session control"));
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.stop();
    }
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<string | undefined> {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
      if (this.stopped) return;
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        if (end > MAX_FRAME) throw new Error("终端输出帧过大，请缩小终端后重连");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.type === "terminal.closed") {
          const reason = String(frame.reason || "终端连接已结束");
          // Startup refusal may arrive as a protocol frame instead of stderr.
          // Let run() classify it before deciding whether to retry.
          if (!this.ready) return reason;
          this.fail(reason); return;
        }
        if (frame.type !== "terminal.frame" || frame.encoding !== "ansi" || typeof frame.bytes !== "string") throw new Error("Herdr 返回了不支持的终端数据");
        // Stop reading the pipe until xterm has consumed the output, keeping input independent.
        if (this.outstanding >= WINDOW) await new Promise<void>((resolve) => {
          this.wake = resolve;
          this.timer = setTimeout(() => this.fail("终端输出积压，请重连"), STALL_MS);
        });
        if (this.stopped) return;
        const size = Buffer.byteLength(frame.bytes);
        const seq = ++this.sent;
        this.frames.set(seq, size);
        this.outstanding += size;
        if (!this.ready) { this.ready = true; clearTimeout(this.timer); }
        if (!this.send({ type: "output", seq, data: frame.bytes, cols: frame.width, rows: frame.height })) return;
      }
      if (pending.length > MAX_FRAME) throw new Error("终端输出帧过大");
    }
  }

  message(raw: string | Buffer): void {
    if (this.stopped) return;
    try {
      const m = JSON.parse(String(raw));
      if (m.type === "ack") {
        if (!Number.isSafeInteger(m.seq) || m.seq > this.sent || m.seq < 0) throw new Error("无效的终端确认");
        if (m.seq <= this.acked) return;
        this.acked = m.seq;
        for (const [seq, size] of this.frames) if (seq <= m.seq) { this.outstanding -= size; this.frames.delete(seq); }
        if (this.outstanding < WINDOW && this.wake) {
          clearTimeout(this.timer);
          const wake = this.wake; this.wake = undefined; wake();
        }
        return;
      }
      if (this.draining) return;
      if (!this.ready) throw new Error("终端尚未连接，输入未发送");
      if (m.type === "input" && typeof m.text === "string" && m.text.length > 0 && Buffer.byteLength(m.text) <= MAX_INPUT) {
        this.write({ type: "terminal.input", text: m.text });
      } else if (m.type === "resize" && terminalGeometry(m.cols, m.rows)) {
        this.write({ type: "terminal.resize", cols: m.cols, rows: m.rows });
      } else if (m.type === "scroll" && ["up", "down"].includes(m.direction) && Number.isInteger(m.lines) && m.lines >= 1 && m.lines <= 200) {
        this.write({ type: "terminal.scroll", direction: m.direction, lines: m.lines });
      } else throw new Error("不支持的终端消息");
    } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  }

  private write(message: unknown): void {
    const line = JSON.stringify(message) + "\n";
    const size = Buffer.byteLength(line);
    if (this.pendingInput + size > MAX_BACKLOG) throw new Error("输入积压，连接已停止；未自动重发");
    this.pendingInput += size;
    this.proc!.stdin.write(line);
    void Promise.resolve(this.proc!.stdin.flush()).then(() => { this.pendingInput -= size; }, () => this.fail("终端输入连接已断开"));
  }

  private fail(message: string): void {
    if (this.stopped) return;
    const taken = /taken.?over|takeover|controller.*elsewhere/i.test(message);
    this.send({ type: "error", message: taken ? "正在连接…" : message, canTakeover: taken });
    this.stop();
  }

  /** Flush accepted input before releasing the controller. The service owns the drain deadline. */
  async drain(): Promise<void> {
    this.draining = true;
    try { await this.proc?.stdin.flush(); } catch { /* a closed pipe cannot accept more input */ }
    this.stop();
    await this.done;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.retryWake?.(); this.retryWake = undefined;
    this.wake?.(); this.wake = undefined;
    // EOF releases the controller on both local and remote Herdr. Kill only our bridge.
    try {
      this.proc?.stdin.write('{"type":"terminal.release"}\n');
      this.proc?.stdin.end();
    } catch { /* already closed */ }
    const proc = this.proc;
    if (proc && !this.draining) {
      const kill = setTimeout(() => proc.kill("SIGKILL"), 1000);
      void proc.exited.finally(() => clearTimeout(kill));
    }
    this.socket.close(1000, "terminal disconnected");
  }
}
