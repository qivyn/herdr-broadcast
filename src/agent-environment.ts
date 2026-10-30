import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { AGENTS } from "./agents.ts";
import { herdrBin, LOCAL } from "./herdr.ts";
import { machineCommand, shellQuote } from "./machine-command.ts";

export interface AgentEnvironment {
  kind: string; name: string; integration: string; guide: string;
  cli: string | null; cliReady: boolean; version: string | null; configDir: string | null; configReady: boolean;
  integrationState: "current" | "outdated" | "missing" | "unknown";
  ready: boolean; reason: string | null;
}
export interface EnvironmentSnapshot { machine: string; checkedAt: number; agents: AgentEnvironment[]; error: string | null }
export type EnvironmentRunner = typeof machineCommand;

/** Resolve Herdr in the target user's environment, never forward integration commands with --machine. */
function binary(machine: string): string {
  return machine === LOCAL ? shellQuote(herdrBin()) : '"${BC_HERDR_BIN}"';
}
const remotePrelude = 'BC_HERDR_BIN=$(command -v herdr 2>/dev/null); if [ -z "$BC_HERDR_BIN" ]; then BC_HERDR_BIN="$HOME/.local/bin/herdr"; fi; ';
export function integrationStatus(text: string, integration: string) {
  const line = text.split("\n").find(l => l.startsWith(`${integration}: `));
  const path = line?.match(/\((\/.*)\)\s*$/)?.[1] ?? null;
  const state = line?.includes(": current ") ? "current" : line?.includes(": outdated ") ? "outdated"
    : line?.includes(": not installed ") ? "missing" : "unknown";
  return { state, path } as const;
}
export async function inspectEnvironment(machine: string, run: EnvironmentRunner = machineCommand, signal?: AbortSignal): Promise<EnvironmentSnapshot> {
  const prelude = machine === LOCAL ? "" : remotePrelude;
  const status = await run(machine, `${prelude}${binary(machine)} integration status`, signal);
  if (status.code !== 0) throw new Error("无法读取 Herdr 集成状态，请检查 SSH 和 Herdr 版本（需要 0.9.5 或更新版本）");
  const results = await Promise.allSettled(AGENTS.map(async a => {
    const integration = integrationStatus(status.stdout, a.integration);
    const configDir = integration.path?.endsWith(a.configSuffix) ? integration.path.slice(0, -a.configSuffix.length) : null;
    const probe = await run(machine, `command -v ${shellQuote(a.cli)} || true\nBC_CLI_VERSION=$(${shellQuote(a.cli)} --version 2>/dev/null); BC_CLI_STATUS=$?\nprintf '%.200s\\n__BC_VERSION_CODE__%s\\n__BC_CONFIG__' "$BC_CLI_VERSION" "$BC_CLI_STATUS"\n${configDir ? `test -d ${shellQuote(configDir)} && printf yes` : "true"}`, signal, 10_000);
    if (probe.code === 255) throw new Error("SSH 连接中断，请重新检查");
    const [reported, config] = probe.stdout.split("__BC_CONFIG__");
    const [cliText, versionCode] = (reported || "").split("__BC_VERSION_CODE__");
    const lines = cliText?.trim().split("\n") ?? [];
    const cli = lines[0]?.startsWith("/") ? lines[0] : null;
    const version = cli ? lines.slice(1).join(" ").slice(0, 200) || null : null;
    const cliReady = !!cli && versionCode?.trim() === "0";
    const kimiVersion = a.kind === "kimi" ? version?.match(/(\d+)\.(\d+)\.(\d+)/) : null;
    const incompatible = !!kimiVersion && Number(kimiVersion[1]) === 0 && Number(kimiVersion[2]) < 14;
    const configReady = config === "yes";
    const reason = !cli ? "未找到 CLI，请按官方指引安装后重新检查" : !cliReady ? "CLI 无法正常运行，请检查运行依赖和版本后重新检查"
      : incompatible ? "Kimi 会话集成需要 CLI 0.14.0 或更新版本，请按官方指引更新"
      : !configReady ? "配置目录尚未初始化，请先启动一次 agent，再重新检查"
      : integration.state === "unknown" ? "无法识别集成状态，请检查 Herdr 版本和配置目录"
      : integration.state !== "current" ? "需要安装或更新会话集成" : null;
    return { kind: a.kind, name: a.name, integration: a.integration, guide: a.guide, cli, cliReady: cliReady && !incompatible, version, configDir,
      configReady, integrationState: integration.state, ready: !reason, reason };
  }));
  const failure = results.find(r => r.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const agents = results.map(r => (r as PromiseFulfilledResult<AgentEnvironment>).value);
  return { machine, checkedAt: Date.now(), agents, error: null };
}

export interface EnvironmentOperation {
  id: string; machine: string; state: "running" | "done" | "failed" | "cancelled" | "interrupted";
  target?: string;
  items: { integration: string; state: "pending" | "checking" | "installing" | "ready" | "failed" | "cancelled"; reason: string | null }[];
  createdAt: number;
}
/** Separate durable operation journal. Recovery records uncertainty and never replays a command. */
export class AgentEnvironments {
  snapshots = new Map<string, EnvironmentSnapshot>();
  private operations: EnvironmentOperation[] = [];
  private pending = new Map<string, { abort: AbortController; work: Promise<void> }>();
  private checks = new Map<string, Promise<EnvironmentSnapshot>>();
  constructor(private file: string, private changed: () => void, private run: EnvironmentRunner = machineCommand) {
    if (existsSync(file)) {
      const records = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(records)) throw new Error("环境操作记录格式无效");
      this.operations = records;
      for (const op of this.operations) if (op.state === "running") {
        op.state = "interrupted";
        for (const item of op.items) if (!["ready", "failed"].includes(item.state)) {
          item.state = "failed"; item.reason = "服务中断，请重新检查实际状态；未自动重试";
        }
      }
      this.save();
    }
  }
  private save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.operations.slice(-100)), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
  private publish() { this.save(); this.changed(); }
  list() { return this.operations; }
  get(id: string) { return this.operations.find(o => o.id === id); }
  /** Reconcile interrupted commands by observation only, after the Web service owns its port. */
  async reconcile() { await Promise.all([...new Set(this.operations.filter(o => o.state === "interrupted").map(o => o.machine))].map(m => this.check(m))); }
  check(machine: string): Promise<EnvironmentSnapshot> {
    const existing = this.checks.get(machine);
    if (existing) return existing;
    const work = inspectEnvironment(machine, this.run).then(snapshot => { this.snapshots.set(machine, snapshot); this.changed(); return snapshot; })
      .catch(error => { const snapshot = { machine, checkedAt: Date.now(), agents: [], error: String((error as Error).message) }; this.snapshots.set(machine, snapshot); this.changed(); return snapshot; })
      .finally(() => this.checks.delete(machine));
    this.checks.set(machine, work);
    return work;
  }
  start(machine: string, names: unknown, target = machine): EnvironmentOperation {
    if (!Array.isArray(names) || !names.length || names.length > AGENTS.length || names.some(n => !AGENTS.some(a => a.integration === n))) throw new Error("请选择有效的集成名称");
    const unique = [...new Set(names as string[])];
    const active = this.operations.find(o => (o.target ?? o.machine) === target && o.state === "running");
    if (active) {
      if (unique.every(n => active.items.some(i => i.integration === n))) return active;
      throw new Error("这台机器已有准备操作，请等待完成后再选择其他集成");
    }
    const op: EnvironmentOperation = { id: randomUUID(), machine, target, state: "running", createdAt: Date.now(), items: unique.map(integration => ({ integration, state: "pending", reason: null })) };
    this.operations.push(op); this.publish();
    const abort = new AbortController();
    const work = this.prepare(op, abort.signal).finally(() => this.pending.delete(op.id));
    this.pending.set(op.id, { abort, work });
    return op;
  }
  private async prepare(op: EnvironmentOperation, signal: AbortSignal) {
    try {
      for (const item of op.items) {
        if (signal.aborted) break;
        try {
          item.state = "checking"; this.publish();
          const before = await inspectEnvironment(op.machine, this.run, signal);
          this.snapshots.set(op.machine, before);
          const agent = before.agents.find(a => a.integration === item.integration)!;
          if (!agent.cliReady || !agent.configReady || agent.integrationState === "unknown") throw new Error(agent.reason!);
          if (!agent.ready) {
            item.state = "installing"; this.publish();
            const result = await this.run(op.machine, `${op.machine === LOCAL ? "" : remotePrelude}${binary(op.machine)} integration install ${shellQuote(item.integration)}`, signal, 60_000);
            if (result.code !== 0) throw new Error("集成安装未完成，请检查配置权限、CLI 兼容版本及 SSH 连接后重新检查");
          }
          const after = await inspectEnvironment(op.machine, this.run, signal);
          this.snapshots.set(op.machine, after);
          if (!after.agents.find(a => a.integration === item.integration)?.ready) throw new Error("安装后检查未通过，请检查配置目录和版本");
          item.state = "ready";
        } catch (error) { item.state = signal.aborted ? "cancelled" : "failed"; item.reason = (error as Error).message; }
        this.publish();
      }
    } finally {
      for (const item of op.items) if (["pending", "checking", "installing"].includes(item.state)) { item.state = "cancelled"; item.reason = "已取消，请重新检查实际状态"; }
      op.state = signal.aborted ? "cancelled" : op.items.some(i => i.state === "failed") ? "failed" : "done";
      this.publish();
    }
  }
  cancel(id: string) { this.pending.get(id)?.abort.abort(); return this.get(id); }
  stop() { for (const item of this.pending.values()) item.abort.abort(); }
  async settle() { await Promise.allSettled([...this.pending.values()].map(p => p.work).concat([...this.checks.values()].map(p => p.then(() => {})))); }
}
